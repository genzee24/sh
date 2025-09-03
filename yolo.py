# pip install ultralytics opencv-python
import os, sys, json
import torch, cv2
from ultralytics import YOLO

IMG_PATH = "/home/sejain/repos/FloorPlanTo3D-API/test.png"
# Put your trained weights here; fallback to a public one for smoke test
WEIGHTS_CANDIDATES = [
    os.getenv("YOLO_WEIGHTS", ""),
    "",
    "yolo11n.pt",   # will auto-download if missing
]

CONF = 0.15       # a bit lower for line-drawings
IOU  = 0.5
IMGSZ = 1280
DEVICE = 0 if torch.cuda.is_available() else "cpu"
OUT_IMG = os.path.splitext(IMG_PATH)[0] + "_detections.jpg"

def pick_weights():
    for w in WEIGHTS_CANDIDATES:
        if not w: continue
        try:
            # YOLO() will auto-download hub weights names like 'yolov8x.pt'
            YOLO(w)
            return w
        except Exception:
            continue
    return "yolov8x.pt"

def main():
    if not os.path.exists(IMG_PATH):
        sys.exit(f"Image not found: {IMG_PATH}")
    img = cv2.imread(IMG_PATH)
    if img is None:
        sys.exit(f"Failed to read image: {IMG_PATH}")

    weights = pick_weights()
    model = YOLO(weights)

    results = model.predict(
        source=IMG_PATH,
        conf=CONF,
        iou=IOU,
        imgsz=IMGSZ,
        device=DEVICE,
        verbose=False
    )

    all_dets = []
    for r in results:
        names = r.names
        has_boxes = getattr(r, "boxes", None) is not None and \
                    getattr(r.boxes, "data", None) is not None and \
                    r.boxes.data.shape[0] > 0

        if not has_boxes:
            print("No detections.")
            continue

        for b in r.boxes:
            cls_id = int(b.cls.item())
            conf = float(b.conf.item())
            x1, y1, x2, y2 = map(float, b.xyxy[0].tolist())
            det = {
                "label": names.get(cls_id, str(cls_id)),
                "confidence": round(conf, 4),
                "bbox_xyxy": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)]
            }
            all_dets.append(det)
            print(f"{det['label']} {det['confidence']:.2f} {det['bbox_xyxy']}")

        # Save annotated image only when there are boxes
        im = r.plot()
        cv2.imwrite(OUT_IMG, im)

    print("\nJSON:", json.dumps({"image": IMG_PATH, "detections": all_dets}, indent=2))
    if all_dets:
        print(f"Annotated image saved → {OUT_IMG}")

if __name__ == "__main__":
    main()
