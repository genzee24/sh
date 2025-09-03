// static/js/depth-capture.js
import * as THREE from "three";

/**
 * Capture a linearized depth PNG (white = far by default).
 * Returns { dataURL, width, height, lo, hi }.
 */
export async function captureLinearDepth(
  renderer,
  scene,
  camera,
  {
    width = 768,
    height = 512,
    whiteIsFar = true,
    autoRange = true,
    percentile = 0.02, // 2%–98% stretch to avoid outliers
  } = {}
) {
  const prev = {
    target: renderer.getRenderTarget(),
    clear: renderer.getClearColor(new THREE.Color()).clone(),
    clearAlpha: renderer.getClearAlpha?.() ?? 1,
    override: scene.overrideMaterial,
  };

  // Render depth to an offscreen target
  const rt = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMat.blending = THREE.NoBlending;

  scene.overrideMaterial = depthMat;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);

  const buf = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);

  // restore
  renderer.setRenderTarget(prev.target);
  renderer.setClearColor(prev.clear, prev.clearAlpha);
  scene.overrideMaterial = prev.override;

  // Decode packed depth → linear meters
  const near = camera.near, far = camera.far;
  const unpack = [1, 1/255, 1/65025, 1/16581375];

  const linear = new Float32Array(width * height);
  for (let i = 0, k = 0; i < width * height; i++) {
    const r = buf[k++] / 255, g = buf[k++] / 255, b = buf[k++] / 255, a = buf[k++] / 255;
    const depth01 = r*unpack[0] + g*unpack[1] + b*unpack[2] + a*unpack[3];
    const zNDC = depth01 * 2.0 - 1.0;
    const z = (2.0 * near * far) / (far + near - zNDC * (far - near)); // meters
    linear[i] = z;
  }

  // Auto-range (percentile)
  let lo = near, hi = far;
  if (autoRange) {
    const vals = Array.from(linear).filter(v => Number.isFinite(v) && v > near && v < far);
    if (vals.length > 32) {
      vals.sort((a,b)=>a-b);
      const a = Math.floor(vals.length * percentile);
      const b = Math.floor(vals.length * (1 - percentile));
      lo = Math.max(near, vals[a]);
      hi = Math.min(far,  vals[b]);
      if (hi - lo < 1e-3) { lo = near; hi = far; }
    }
  }

  // Map to 8-bit grayscale
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let v = (linear[i] - lo) / (hi - lo);
    v = Math.max(0, Math.min(1, v));
    if (!whiteIsFar) v = 1 - v;
    const c = (v * 255) | 0;
    const j = i*4;
    out[j] = out[j+1] = out[j+2] = c;
    out[j+3] = 255;
  }

  // Flip Y (readPixels origin is bottom-left)
  const row = width * 4;
  for (let y = 0; y < (height >> 1); y++) {
    const a = y * row, b = (height - 1 - y) * row;
    for (let x = 0; x < row; x++) {
      const t = out[a + x]; out[a + x] = out[b + x]; out[b + x] = t;
    }
  }

  // PNG dataURL
  const cvs = document.createElement("canvas");
  cvs.width = width; cvs.height = height;
  const ctx = cvs.getContext("2d");
  ctx.putImageData(new ImageData(out, width, height), 0, 0);
  const dataURL = cvs.toDataURL("image/png");

  return { dataURL, width, height, lo, hi };
}
