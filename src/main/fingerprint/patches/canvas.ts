import type { FingerprintConfig } from '@shared/types'

/** Canvas 指纹：getImageData / toDataURL / toBlob / measureText 确定性扰动 */
export function canvasPatch(_fp: FingerprintConfig): string {
  return `
// --- Canvas ---
(function () {
  const C = CFG.canvas;
  if (C.mode === 'off') return;
  const factor = Math.max(0, C.noiseFactor);
  const base = strHash(String(C.seed || CFG.seed));

  function noiseAt(index, value) {
    // 由 (seed, 像素位置, 原值) 推导 -> 同一画面每次结果一致
    let h = (base ^ (index * 2654435761) ^ (value * 40503)) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 2246822519) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h % (2 * factor + 1)) - factor;
  }
  function applyNoise(data) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clamp8(data[i] + noiseAt(i, data[i]));
      data[i + 1] = clamp8(data[i + 1] + noiseAt(i + 1, data[i + 1]));
      data[i + 2] = clamp8(data[i + 2] + noiseAt(i + 2, data[i + 2]));
      // alpha 保持，避免可见异常
    }
  }
  function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  const ctxProto = CanvasRenderingContext2D.prototype;
  const origGetImageData = ctxProto.getImageData;
  if (origGetImageData) {
    ctxProto.getImageData = hideNative(function getImageData() {
      const img = origGetImageData.apply(this, arguments);
      if (factor > 0) applyNoise(img.data);
      return img;
    }, 'getImageData');
  }

  function renoise(canvas) {
    if (factor <= 0) return canvas;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const c2d = copy.getContext('2d');
    c2d.drawImage(canvas, 0, 0);
    const img = origGetImageData.call(c2d, 0, 0, canvas.width, canvas.height);
    applyNoise(img.data);
    c2d.putImageData(img, 0, 0);
    return copy;
  }

  const htmlProto = HTMLCanvasElement.prototype;
  const origToDataURL = htmlProto.toDataURL;
  if (origToDataURL && C.toDataURLNoise) {
    htmlProto.toDataURL = hideNative(function toDataURL() {
      return origToDataURL.apply(renoise(this), arguments);
    }, 'toDataURL');
  }
  const origToBlob = htmlProto.toBlob;
  if (origToBlob && C.toDataURLNoise) {
    htmlProto.toBlob = hideNative(function toBlob(cb) {
      return origToBlob.apply(renoise(this), arguments);
    }, 'toBlob');
  }

  if (C.textMetricsNoise) {
    const origMeasure = ctxProto.measureText;
    if (origMeasure) {
      ctxProto.measureText = hideNative(function measureText(text) {
        const m = origMeasure.apply(this, arguments);
        const h = strHash(String(text) + '|' + base);
        const delta = ((h % 200) - 100) / 100000;
        try {
          const patched = Object.create(TextMetrics.prototype);
          patched.width = m.width + delta;
          patched.actualBoundingBoxLeft = m.actualBoundingBoxLeft;
          patched.actualBoundingBoxRight = m.actualBoundingBoxRight;
          patched.fontBoundingBoxAscent = m.fontBoundingBoxAscent;
          patched.fontBoundingBoxDescent = m.fontBoundingBoxDescent;
          patched.actualBoundingBoxAscent = m.actualBoundingBoxAscent;
          patched.actualBoundingBoxDescent = m.actualBoundingBoxDescent;
          return patched;
        } catch (e) { return m; }
      }, 'measureText');
    }
  }
})();
`
}
