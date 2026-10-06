import type { FingerprintConfig } from '@shared/types'

/**
 * WebGPU adapter info 覆盖。
 *
 * 为什么必须做：navigator.gpu.requestAdapter() 拿到的 adapter 会直接返回真实
 * GPU 厂商与型号（Apple M1 / NVIDIA GeForce RTX 4070），完全绕过 WebGL 层的
 * vendor/renderer 改写。只改 WebGL 不改这里，两个 API 会互相打脸。
 *
 * requestAdapterInfo() 在新版 Chrome 已废弃、改为 adapter.info 属性，
 * 两条路径都要覆盖，否则检测站会走另一条读到真值。
 */
export function webgpuPatch(_fp: FingerprintConfig): string {
  return `
// --- WebGPU ---
(function () {
  const G = CFG.webgpu;
  if (!navigator.gpu) return;
  if (!G.enabled) {
    // 关掉 WebGPU：移除入口。真实 Chrome 是有 navigator.gpu 的，
    // 所以只有老内核 / 明确禁用的场景才该走这里，一致性体检已覆盖。
    try { delete navigator.gpu; } catch (e) { patchProp(navigator, 'gpu', function () { return undefined; }); }
    return;
  }
  const INFO = {
    vendor: G.vendor || '',
    architecture: G.architecture || '',
    device: G.device || '',
    description: G.description || ''
  };

  const patchedAdapters = new WeakSet();
  function patchAdapter(adapter) {
    if (!adapter || patchedAdapters.has(adapter)) return adapter;
    patchedAdapters.add(adapter);
    // 新版：adapter.info 只读访问器
    define(adapter, 'info', { configurable: true, get: function () { return Object.assign({}, INFO); } });
    // 旧版：requestAdapterInfo()
    if (typeof adapter.requestAdapterInfo === 'function') {
      adapter.requestAdapterInfo = hideNative(function requestAdapterInfo() {
        return Promise.resolve(Object.assign({}, INFO));
      }, 'requestAdapterInfo');
    }
    return adapter;
  }

  const origRequest = navigator.gpu.requestAdapter;
  if (origRequest) {
    navigator.gpu.requestAdapter = hideNative(function requestAdapter(options) {
      const opts = (options && Object.keys(options).length) || !G.powerPreference
        ? options
        : { powerPreference: G.powerPreference };
      const p = opts ? origRequest.call(navigator.gpu, opts) : origRequest.call(navigator.gpu);
      return Promise.resolve(p).then(function (adapter) {
        return adapter ? patchAdapter(adapter) : null;
      });
    }, 'requestAdapter');
  }

  // GPUDevice.adapter 同样会把原始 adapter 交给页面
  if (typeof GPUDevice !== 'undefined') {
    const d = Object.getOwnPropertyDescriptor(GPUDevice.prototype, 'adapter');
    if (d && d.get) {
      define(GPUDevice.prototype, 'adapter', {
        configurable: true,
        enumerable: d.enumerable,
        get: hideNative(function get() {
          const a = d.get.call(this);
          return a ? patchAdapter(a) : a;
        }, 'get adapter')
      });
    }
  }
})();
`
}