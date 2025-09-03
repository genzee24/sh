# depth_server.py
import io, os, base64
from PIL import Image, ImageDraw, ImageFont
from flask import Flask, request, jsonify
from flask_cors import CORS

# -------- Optional: real ControlNet (auto-fallback if unavailable) --------
DIFFUSERS_AVAILABLE = False
try:
    from diffusers import StableDiffusionControlNetPipeline, ControlNetModel
    import torch
    DIFFUSERS_AVAILABLE = True
except Exception:
    DIFFUSERS_AVAILABLE = False

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

_pipe = None

def _lazy_load_pipe():
    """Load SD + ControlNet(Depth) once, if installed."""
    global _pipe
    if _pipe is not None:
        return _pipe

    controlnet_id = os.environ.get("CONTROLNET_MODEL", "lllyasviel/sd-controlnet-depth")
    base_id = os.environ.get("SD_MODEL", "runwayml/stable-diffusion-v1-5")

    dtype = (torch.float16 if torch.cuda.is_available() else torch.float32)
    cn = ControlNetModel.from_pretrained(controlnet_id, torch_dtype=dtype)
    pipe = StableDiffusionControlNetPipeline.from_pretrained(
        base_id,
        controlnet=cn,
        torch_dtype=dtype,
        safety_checker=None,
    )
    device = "cuda" if torch.cuda.is_available() else "cpu"
    pipe.to(device)
    _pipe = pipe
    print(f"✅ ControlNet loaded ({controlnet_id}) with base ({base_id}) on {device}")
    return pipe

def _img_to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")

def _fallback_overlay(depth_img: Image.Image, prompt: str) -> Image.Image:
    """No diffusers installed? Return readable demo output."""
    img = depth_img.convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    bar_h = max(32, img.height // 10)
    draw.rectangle([0, img.height - bar_h, img.width, img.height], fill=(0,0,0,140))
    try:
        font = ImageFont.truetype("arial.ttf", size=max(14, bar_h - 12))
    except Exception:
        font = ImageFont.load_default()
    draw.text((12, img.height - bar_h + 6), prompt, fill=(255,255,255,235), font=font)
    return Image.alpha_composite(img, overlay).convert("RGB")

@app.route("/health")
def health():
    return jsonify(ok=True, diffusers=DIFFUSERS_AVAILABLE)

@app.route("/txt_depth_generate", methods=["POST"])
def txt_depth_generate():
    # Required
    prompt = (request.form.get("prompt") or "").strip()
    if not prompt:
        return jsonify(error="field 'prompt' missing"), 400
    if "depth" not in request.files:
        return jsonify(error="field 'depth' missing"), 400

    # Optional args
    steps    = int(request.form.get("steps", 28))
    guidance = float(request.form.get("guidance", 7.5))
    size     = int(request.form.get("size", 512))
    size = max(128, min(1024, size))  # sane clamp

    try:
        depth_img = Image.open(request.files["depth"].stream).convert("L")
        rgb_file  = request.files.get("rgb")
        rgb_img   = Image.open(rgb_file.stream).convert("RGB") if rgb_file else None
    except Exception as e:
        return jsonify(error=f"invalid image(s): {e}"), 400

    if DIFFUSERS_AVAILABLE:
        try:
            pipe = _lazy_load_pipe()
            control = depth_img.resize((size, size))
            # text2img + depth (if you want img2img+depth, we can switch pipelines)
            with torch.inference_mode():
                out = pipe(
                    prompt,
                    image=control,
                    num_inference_steps=steps,
                    guidance_scale=guidance
                ).images[0]
            return jsonify(image=_img_to_data_url(out))
        except Exception as e:
            # fall back to readable demo if the model chokes
            print("ControlNet generation error:", e)

    # Fallback path (no diffusers installed)
    preview = _fallback_overlay(depth_img, prompt)
    return jsonify(image=_img_to_data_url(preview))

if __name__ == "__main__":
    app.run('0.0.0.0', port=5105, debug=True)
