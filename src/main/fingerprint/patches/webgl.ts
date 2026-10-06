import type { FingerprintConfig } from '@shared/types'

/** WebGL / WebGL2：UNMASKED_VENDOR/RENDERER、扩展列表、getParameter 表 */
export function webglPatch(_fp: FingerprintConfig): string {
  return `
// --- WebGL ---
(function () {
  const W = CFG.webgl;
  if (!W.enabled) return;
  const ENUM = {
    VENDOR: 7936, RENDERER: 7937, VERSION: 7938, SHADING_LANGUAGE_VERSION: 35724,
    UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446,
    MAX_TEXTURE_SIZE: 3379, MAX_CUBE_MAP_TEXTURE_SIZE: 34076, MAX_RENDERBUFFER_SIZE: 34024,
    MAX_VERTEX_ATTRIBS: 34921, MAX_VERTEX_UNIFORM_VECTORS: 36347, MAX_FRAGMENT_UNIFORM_VECTORS: 36349,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661, MAX_TEXTURE_IMAGE_UNITS: 35660,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660, MAX_SAMPLES: 36184, MAX_SAMPLES_INT: 36184,
    MAX_ARRAY_TEXTURE_LAYERS: 35071, MAX_3D_TEXTURE_SIZE: 32883, MAX_DRAW_BUFFERS: 34852,
    MAX_COLOR_ATTACHMENTS: 36063, MAX_COMBINED_UNIFORM_BLOCKS: 35674,
    MAX_UNIFORM_BLOCK_SIZE: 35676, MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 35978,
    MAX_VARYING_VECTORS: 36348, MAX_ELEMENTS_INDICES: 33001, MAX_ELEMENTS_VERTICES: 33000
  };
  const ARRAY_ENUM = {
    MAX_VIEWPORT_DIMS: 3386, ALIASED_LINE_WIDTH_RANGE: 33902, ALIASED_POINT_SIZE_RANGE: 33901,
    MAX_TEXTURE_MAX_ANISOTROPY_EXT: 34047
  };
  function valueFor(pname) {
    if (pname === ENUM.UNMASKED_VENDOR_WEBGL) return W.vendor;
    if (pname === ENUM.UNMASKED_RENDERER_WEBGL) return W.renderer;
    if (pname === ENUM.VENDOR) return W.vendor;
    if (pname === ENUM.RENDERER) return W.renderer;
    if (pname === ENUM.VERSION) return W.version;
    if (pname === ENUM.SHADING_LANGUAGE_VERSION) return W.shadingLanguageVersion;
    for (const k in CFG.webgl.parameters) {
      if (ENUM[k] === pname) return CFG.webgl.parameters[k];
    }
    return undefined;
  }
  function patch(proto) {
    if (!proto) return;
    const origGet = proto.getParameter;
    if (origGet) {
      proto.getParameter = hideNative(function getParameter(pname) {
        const v = valueFor(pname);
        if (v !== undefined) return v;
        return origGet.call(this, pname);
      }, 'getParameter');
    }
    const origExt = proto.getSupportedExtensions;
    if (origExt && W.extensions.length) {
      proto.getSupportedExtensions = hideNative(function getSupportedExtensions() {
        return W.extensions.slice();
      }, 'getSupportedExtensions');
    }
    const origGetExt = proto.getExtension;
    if (origGetExt) {
      proto.getExtension = hideNative(function getExtension(name) {
        if (name === 'WEBGL_debug_renderer_info') {
          return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
        }
        if (W.extensions.length && W.extensions.indexOf(name) < 0) return null;
        return origGetExt.call(this, name);
      }, 'getExtension');
    }

    // getShaderPrecisionFormat：真实 GPU 之间差异很大，是稳定的设备信号。
    // 不改这里，vendor/renderer 改得再真也会被这一项对不上。
    const origPrec = proto.getShaderPrecisionFormat;
    if (origPrec) {
      const PREC = {
        VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
        LOW_FLOAT: 36336, MEDIUM_FLOAT: 36337, HIGH_FLOAT: 36338,
        LOW_INT: 36339, MEDIUM_INT: 36340, HIGH_INT: 36341
      };
      // 桌面主流 GPU 的典型值（ANGLE/Metal/D3D 都落在这个区间）
      function tableFor(precisionType) {
        if (precisionType === PREC.LOW_FLOAT) return { rangeMin: 127, rangeMax: 127, precision: 10 };
        if (precisionType === PREC.MEDIUM_FLOAT) return { rangeMin: 127, rangeMax: 127, precision: 14 };
        if (precisionType === PREC.HIGH_FLOAT) return { rangeMin: 127, rangeMax: 127, precision: 23 };
        if (precisionType === PREC.LOW_INT || precisionType === PREC.MEDIUM_INT) return { rangeMin: 15, rangeMax: 15, precision: 0 };
        return { rangeMin: 23, rangeMax: 23, precision: 0 };
      }
      proto.getShaderPrecisionFormat = hideNative(function getShaderPrecisionFormat(shaderType, precisionType) {
        const t = tableFor(precisionType);
        // 返回带原型的对象而不是裸对象，避免 constructor 特征露馅
        const orig = origPrec.call(this, shaderType, precisionType);
        const Ctor = orig && orig.constructor;
        let out;
        try { out = Ctor ? Object.create(Ctor.prototype) : {}; } catch (e) { out = {}; }
        define(out, 'rangeMin', { get: function () { return t.rangeMin; } });
        define(out, 'rangeMax', { get: function () { return t.rangeMax; } });
        define(out, 'precision', { get: function () { return t.precision; } });
        return out;
      }, 'getShaderPrecisionFormat');
    }

    // readPixels：检测站会渲染一段固定场景再哈希像素，真实 GPU 之间结果不同。
    // 噪声由 seed 决定 => 同一 profile 每次一致，不同 profile 之间可区分。
    const canvasNoise = CFG.canvas && CFG.canvas.mode !== 'off';
    if (canvasNoise) {
      const factor = Math.max(0, CFG.canvas.noiseFactor || 0);
      const seedBase = strHash(String(CFG.canvas.seed || CFG.seed) + '|glpix');
      function delta(x, y, ch, value) {
        let h = (seedBase ^ Math.imul(x + 1, 2246822519) ^ Math.imul(y + 1, 3266489917) ^ Math.imul(ch + 1, 668265263) ^ Math.imul(value + 1, 374761393)) >>> 0;
        h = (h ^ (h >>> 15)) >>> 0;
        h = Math.imul(h, 2246822507) >>> 0;
        h = (h ^ (h >>> 13)) >>> 0;
        const span = Math.max(1, Math.round(factor * 255));
        return (h % (2 * span + 1)) - span;
      }
      const origRead = proto.readPixels;
      if (origRead) {
        proto.readPixels = hideNative(function readPixels(x, y, width, height, format, type, pixels) {
          origRead.apply(this, arguments);
          if (!pixels || typeof pixels.length !== 'number' || factor <= 0) return;
          const channels = format === 6407 ? 3 : format === 6408 ? 4 : 4;
          const isFloat = pixels instanceof Float32Array;
          for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
              const base = (row * width + col) * channels;
              for (let c = 0; c < channels; c++) {
                const idx = base + c;
                if (idx >= pixels.length) break;
                if (c === 3 && !isFloat) continue; // 不动 alpha，避免透明边缘出现可见异常
                const v = pixels[idx];
                if (isFloat) {
                  const d = delta(x + col, y + row, c, Math.round(v * 1e5)) / 1e5;
                  pixels[idx] = v + d * factor;
                } else {
                  pixels[idx] = Math.max(0, Math.min(255, v + delta(x + col, y + row, c, v)));
                }
              }
            }
          }
        }, 'readPixels');
      }
    }
  }
  if (typeof WebGLRenderingContext !== 'undefined') patch(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
  void ARRAY_ENUM;
})();
`
}
