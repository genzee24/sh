"""
Furniture-placement micro-service (port 5200)
─────────────────────────────────────────────────────────────────────
POST /furnish         (multipart/form-data)  -> GPT-based furniture
  • image : file
  • json  : string (your detection JSON from UI)

POST /furnish/yolo    (multipart/form-data)  -> YOLO furniture detection
  • image : file
  • json  : string (same baseline JSON; used to carry Width/Height)
  • [optional] mode=detect|obb   default detect
  • [optional] conf=0.25         confidence threshold
  • [optional] iou=0.45          NMS IoU threshold

200 → original JSON + {"furniture":[{x1,y1,x2,y2,type,room,confidence}]}
"""
import os
import os, io, re, json, base64
from typing import Any, Dict, List, Tuple

import numpy as np
from PIL import Image
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

# ───────────────────────────────────────────────────────────────────
#  ENV & OpenAI client (reads OPENAI_API_KEY from env or .env)
# ───────────────────────────────────────────────────────────────────
load_dotenv()
if not os.getenv("OPENAI_API_KEY"):
    raise RuntimeError("OPENAI_API_KEY is not set (export it or put it in .env)")

from openai import OpenAI
oa_client = OpenAI()

# ───────────────────────────────────────────────────────────────────
#  Flask
# ───────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

# add near the top with other imports
from PIL import ImageOps, ImageFilter

# --- NEW: simple floor-plan preprocessing (PIL-based) ---
def fp_preprocess(np_img: np.ndarray, mode: str = "auto") -> np.ndarray:
    """
    For black/gray line drawings: boost contrast, binarize, thicken lines.
    Returns RGB np.uint8 HxWx3. mode='none' to bypass.
    """
    if mode == "none":
        return np_img

    im = Image.fromarray(np_img).convert("L")
    im = ImageOps.autocontrast(im, cutoff=2)               # normalize contrast
    # adaptive-ish threshold via point + autocontrast works well enough here
    bw = im.point(lambda p: 255 if p > 200 else 0)         # binarize
    bw = bw.filter(ImageFilter.MaxFilter(size=3))          # thicken lines (dilate)

    # YOLO prefers natural-looking RGB; invert to dark-on-light if needed
    # Try both – empirically invert=True often works better for plans:
    inv = ImageOps.invert(bw)
    rgb = Image.merge("RGB", (inv, inv, inv))
    return np.array(rgb, dtype=np.uint8)


# Common lists (for GPT instructions + normalization)
FURNITURE_LIST = (
    "sofa, armchair, coffee table, tv stand, dining table, dining chair, "
    "bed, nightstand, wardrobe/closet, dresser, desk, office chair, "
    "bookshelf, kitchen counter, stove/cooktop, sink, fridge, oven, "
    "island, bathtub, shower, toilet, bathroom sink/vanity, washing machine, dryer, "
    "rug, side table, bench, shoe rack, radiator"
)
ROOM_LIST = (
    "living, bedroom, kitchen, bathroom, corridor, storage, balcony, porch, "
    "garage, office, great room, dining, master, unknown"
)

PROMPT = f"""
You are an architectural assistant.

INPUTS:
  • A floor-plan image (PNG/JPEG).
  • A detection JSON from our UI with
      points  – list of boxes for structural elements
      classes – list of names parallel to points
      Width, Height, averageDoor

TASK:
  Infer likely furniture positions from the image and the given structure,
  and return them as additional axis-aligned boxes in pixel coordinates.

REQUIREMENTS:
  • Do NOT modify the given 'points', 'classes', 'Width', 'Height', 'averageDoor'.
  • Add a new top-level array:  "furniture".
  • Each furniture item must be an object with keys:
      - x1, y1, x2, y2  (integers, image pixel space)
      - type            (one of: {FURNITURE_LIST})
      - room            (one of: {ROOM_LIST})
      - confidence      (0..1 float)
  • Boxes MUST satisfy x1 < x2 and y1 < y2.
  • Do NOT hallucinate dense furniture—only include items you clearly see
    or can strongly infer from the plan symbols.
  • If room is unclear, use "unknown".
  • Keep counts manageable (prefer fewer, high-confidence items).
  • Ensure all boxes lie within [0, Width) × [0, Height).

OUTPUT:
Return ONE raw JSON object with the SAME top-level keys you received
(points, classes, Width, Height, averageDoor) PLUS "furniture".
No markdown fences, no escaping.
"""

# ───────────────────────────────────────────────────────────────────
#  Helpers (shared by GPT & YOLO)
# ───────────────────────────────────────────────────────────────────
def clean_and_load(raw: str) -> Dict[str, Any]:
    """Parse model reply whether it's fenced or twice-encoded."""
    txt = raw.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```[a-z]*\n?", "", txt, 1, flags=re.I).rstrip("`").strip()
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        pass
    try:
        inner = json.loads(txt)  # becomes str
        return json.loads(inner)
    except Exception as e:
        raise ValueError(f"Could not parse JSON: {e}")

def clamp_int(v: Any, lo: int, hi: int) -> int:
    try:
        iv = int(round(float(v)))
    except Exception:
        iv = lo
    return max(lo, min(hi, iv))

def normalize_furniture_boxes(doc: Dict[str, Any]) -> None:
    """Clamp/order furniture boxes to image bounds; drop invalids."""
    W = int(doc.get("Width", 0) or 0)
    H = int(doc.get("Height", 0) or 0)
    furn = doc.get("furniture", [])
    out: List[Dict[str, Any]] = []
    for it in furn:
        x1 = clamp_int(it.get("x1", 0), 0, max(0, W - 1))
        y1 = clamp_int(it.get("y1", 0), 0, max(0, H - 1))
        x2 = clamp_int(it.get("x2", 0), 0, max(0, W - 1))
        y2 = clamp_int(it.get("y2", 0), 0, max(0, H - 1))
        if x2 <= x1 or y2 <= y1:
            x1, x2 = min(x1, x2), max(x1, x2)
            y1, y2 = min(y1, y2), max(y1, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        out.append({
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "type": str(it.get("type", "unknown")).lower(),
            "room": str(it.get("room", "unknown")).lower(),
            "confidence": float(it.get("confidence", 0.0))
        })
    doc["furniture"] = out

def merge_with_baseline(raw_json: str, furniture: List[Dict[str, Any]], dims: Tuple[int,int]) -> Dict[str, Any]:
    """Take original JSON + furniture list; ensure required keys exist; clamp boxes."""
    try:
        orig = json.loads(raw_json)
    except Exception:
        orig = {}

    W = int(orig.get("Width") or 0)
    H = int(orig.get("Height") or 0)
    if not (W and H):
        # Fallback to image dims if JSON didn't carry them
        W, H = dims

    enriched = dict(orig)
    enriched["Width"] = W
    enriched["Height"] = H
    enriched.setdefault("points", orig.get("points", []))
    enriched.setdefault("classes", orig.get("classes", []))
    enriched.setdefault("averageDoor", orig.get("averageDoor", 0))

    # Fill defaults: room=unknown, confidence present
    fixed_furn = []
    for f in furniture:
        fixed_furn.append({
            "x1": int(round(float(f.get("x1", 0)))),
            "y1": int(round(float(f.get("y1", 0)))),
            "x2": int(round(float(f.get("x2", 0)))),
            "y2": int(round(float(f.get("y2", 0)))),
            "type": str(f.get("type", "unknown")).lower(),
            "room": str(f.get("room", "unknown")).lower(),
            "confidence": float(f.get("confidence", f.get("score", 0.0))),
        })
    enriched["furniture"] = fixed_furn
    normalize_furniture_boxes(enriched)
    enriched.setdefault("schema_version", "furnish.v1")
    return enriched

# ───────────────────────────────────────────────────────────────────
#  GPT call
# ───────────────────────────────────────────────────────────────────
def call_gpt_vision(image_b64: str, raw_json: str, mime: str) -> Dict[str, Any]:
    """Call GPT (Responses API) with image + JSON context."""
    rsp = oa_client.responses.create(
        model="gpt-5",
        input=[{
            "role": "user",
            "content": [
                {"type": "input_text",  "text": PROMPT},
                {"type": "input_text",  "text": raw_json},
                {"type": "input_image", "image_url": f"data:{mime};base64,{image_b64}"},
            ],
        }],
    )
    answer = getattr(rsp, "output_text", None)
    if not answer:
        answer = json.dumps(rsp.model_dump(), ensure_ascii=False)
    return clean_and_load(answer)

# ───────────────────────────────────────────────────────────────────
#  YOLO (Ultralytics) – optional OBB
# ───────────────────────────────────────────────────────────────────
_ultra_ok = True
try:
    from ultralytics import YOLO
except Exception:
    _ultra_ok = False
    YOLO = None  # type: ignore

YOLO_DET_MODEL = os.getenv("YOLO_MODEL_DET", "yolov8n.pt")
YOLO_OBB_MODEL = os.getenv("YOLO_MODEL_OBB", "yolov8n-obb.pt")
_det_model = None
_obb_model = None

# label normalization / filtering
FURNITURE_WHITELIST = {
    "bed", "sofa", "couch", "armchair", "chair", "dining table", "table", "tv",
    "tv stand", "refrigerator", "fridge", "microwave", "oven", "stove", "stove/cooktop",
    "sink", "toilet", "shower", "bathtub", "bookshelf", "desk", "bench",
    "wardrobe", "closet", "dresser", "nightstand", "island", "vanity",
    "washing machine", "dryer", "rug", "side table", "shoe rack", "radiator",
}
SYNONYM_MAP = {
    "couch": "sofa",
    "refrigerator": "fridge",
    "stove": "stove/cooktop",
    "dining table": "table",
    "tvmonitor": "tv",
}

def _normalize_label(raw: str) -> str:
    lab = (raw or "").strip().lower()
    return SYNONYM_MAP.get(lab, lab)

def _is_furniture(label: str) -> bool:
    lab = label.lower()
    return (lab in FURNITURE_WHITELIST) or (lab in SYNONYM_MAP)

def _xyxy_of_polygon(poly8: np.ndarray):
    xs = poly8[0::2]; ys = poly8[1::2]
    return float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())

def _get_yolo_model(mode: str):
    if not _ultra_ok:
        raise RuntimeError("Ultralytics not installed. pip install ultralytics")
    global _det_model, _obb_model
    if mode == "obb":
        if _obb_model is None:
            _obb_model = YOLO(YOLO_OBB_MODEL)
        return _obb_model
    else:
        if _det_model is None:
            _det_model = YOLO(YOLO_DET_MODEL)
        return _det_model

def detect_with_yolo(np_img: np.ndarray, mode: str = "detect", conf: float = 0.25, iou: float = 0.45) -> Tuple[List[Dict[str, Any]], str]:
    """
    Returns furniture list: {x1,y1,x2,y2,type,confidence}  and mode_used.
    """
    model = _get_yolo_model("obb" if mode == "obb" else "detect")
    results = model.predict(source=np_img, conf=conf, iou=iou, verbose=False)

    furniture: List[Dict[str, Any]] = []
    mode_used = "obb" if mode == "obb" else "detect"

    for r in results:
        names = r.names

        # Try OBB first if requested and supported
        used_obb = False
        if mode_used == "obb" and getattr(r, "obb", None) is not None:
            obb = r.obb
            try:
                polys = obb.xyxyxyxy.cpu().numpy()
                cls   = obb.cls.cpu().numpy()
                confs = obb.conf.cpu().numpy()
                used_obb = True
            except Exception:
                used_obb = False

            if used_obb:
                for poly8, c, s in zip(polys, cls, confs):
                    label_raw = names.get(int(c), f"class_{int(c)}")
                    label = _normalize_label(label_raw)
                    if not _is_furniture(label): continue
                    x1, y1, x2, y2 = _xyxy_of_polygon(poly8)
                    furniture.append({
                        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "type": label, "confidence": float(s),
                    })

        # Fallback / standard boxes
        boxes = getattr(r, "boxes", None)
        if boxes is not None:
            try:
                xyxy = boxes.xyxy.cpu().numpy()
                cls  = boxes.cls.cpu().numpy()
                conf = boxes.conf.cpu().numpy()
            except Exception:
                continue
            for (x1, y1, x2, y2), c, s in zip(xyxy, cls, conf):
                label_raw = names.get(int(c), f"class_{int(c)}")
                label = _normalize_label(label_raw)
                if not _is_furniture(label): continue
                furniture.append({
                    "x1": float(x1), "y1": float(y1),
                    "x2": float(x2), "y2": float(y2),
                    "type": label, "confidence": float(s),
                })

    return furniture, mode_used

# ───────────────────────────────────────────────────────────────────
#  Routes
# ───────────────────────────────────────────────────────────────────
@app.route("/health")
def health():
    return "ok", 200

@app.route("/furnish", methods=["POST"])
def furnish_gpt():
    if "image" not in request.files or "json" not in request.form:
        return jsonify(error="Need 'image' file and 'json' text field"), 400

    file = request.files["image"]
    mime = (file.mimetype or "").lower()
    if mime not in ("image/png", "image/jpeg", "image/jpg"):
        return jsonify(error="Unsupported image type (use PNG or JPEG)"), 400

    img_bytes = file.read()
    if len(img_bytes) > 4_000_000:
        return jsonify(error="Image too large (>4 MB)"), 400
    img_b64 = base64.b64encode(img_bytes).decode()

    raw_json = request.form["json"]

    # 1) Call GPT
    try:
        enriched = call_gpt_vision(img_b64, raw_json, mime)
    except Exception as e:
        return jsonify(error=str(e)), 500

    # 2) Ensure baseline keys + clamp
    try:
        im = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        dims = (im.width, im.height)
    except Exception:
        dims = (0, 0)

    if "furniture" not in enriched or not isinstance(enriched["furniture"], list):
        enriched["furniture"] = []

    enriched = merge_with_baseline(raw_json, enriched["furniture"], dims)
    return jsonify(enriched)

@app.route("/furnish/yolo", methods=["POST"])
def furnish_yolo():
    if "image" not in request.files or "json" not in request.form:
        return jsonify(error="Need 'image' file and 'json' text field"), 400

    mode = (request.args.get("mode", "detect") or "detect").lower()
    if mode not in ("detect", "obb"):
        mode = "detect"
    try:
        conf = float(request.args.get("conf", "0.15"))   # lower default helps
        iou  = float(request.args.get("iou", "0.50"))
    except Exception:
        conf, iou = 0.15, 0.50

    prep = (request.args.get("prep", "auto") or "auto").lower()  # NEW

    img_bytes = request.files["image"].read()
    raw_json  = request.form["json"]

    # load image -> numpy
    try:
        im = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        np_img = np.array(im)
        dims = (im.width, im.height)
    except Exception as e:
        return jsonify(error=f"Bad image: {e}"), 400

    # NEW: floor-plan preprocessing
    try:
        np_img_pre = fp_preprocess(np_img, prep)
    except Exception as e:
        np_img_pre = np_img  # fail-open

    # detect
    try:
        furniture, mode_used = detect_with_yolo(np_img_pre, mode=mode, conf=conf, iou=iou)
        print(furniture)
    except Exception as e:
        return jsonify(error=f"YOLO error: {e}"), 500

    for f in furniture:
        f.setdefault("room", "unknown")

    enriched = merge_with_baseline(raw_json, furniture, dims)
    enriched["yolo_mode"] = mode_used
    enriched["prep"] = prep
    return jsonify(enriched)
# ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5200, debug=False)
