import type { FingerprintConfig } from '@shared/types'

/** 电池 / 网络信息 / 媒体设备 / 存储配额 / performance.memory */
export function miscPatch(_fp: FingerprintConfig): string {
  return `
// --- Battery ---
(function () {
  const B = CFG.battery;
  if (!B.enabled || typeof navigator.getBattery !== 'function') return;
  navigator.getBattery = hideNative(function getBattery() {
    const mgr = {
      charging: B.charging,
      chargingTime: B.chargingTime,
      dischargingTime: B.dischargingTime,
      level: B.level,
      addEventListener: function () {},
      removeEventListener: function () {},
      onchargingchange: null, onchargingtimechange: null,
      ondischargingtimechange: null, onlevelchange: null
    };
    return Promise.resolve(mgr);
  }, 'getBattery');
})();

// --- Network Information ---
(function () {
  const N = CFG.connection;
  if (!N.enabled) { patchProp(navigator, 'connection', function () { return undefined; }); return; }
  const conn = {
    effectiveType: N.effectiveType, rtt: N.rtt, downlink: N.downlink, saveData: N.saveData, type: N.type,
    addEventListener: function () {}, removeEventListener: function () {}, onchange: null
  };
  patchProp(navigator, 'connection', function () { return conn; });
  // mozConnection 在 Chrome 里根本不存在；刻意定义一个返回 undefined 的属性
  // 反而会在 navigator 上留下 own property，所以只在它存在时删掉。
  try { if (Object.prototype.hasOwnProperty.call(navigator, 'mozConnection')) delete navigator.mozConnection; } catch (e) {}
})();

// --- MediaDevices ---
(function () {
  const M = CFG.media;
  if (!M.enabled || !navigator.mediaDevices) return;
  const origEnumerate = navigator.mediaDevices.enumerateDevices;
  if (!origEnumerate) return;
  navigator.mediaDevices.enumerateDevices = hideNative(function enumerateDevices() {
    if (!M.devices.length) return origEnumerate.call(navigator.mediaDevices);
    return Promise.resolve(M.devices.map(function (d, i) {
      return {
        kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId,
        toJSON: function () { return { kind: this.kind, label: this.label, deviceId: this.deviceId, groupId: this.groupId }; }
      };
    }));
  }, 'enumerateDevices');
})();

// --- storage.estimate ---
(function () {
  const S = CFG.storage;
  if (!navigator.storage) return;
  const origEstimate = navigator.storage.estimate;
  if (!origEstimate) return;
  navigator.storage.estimate = hideNative(function estimate() {
    return origEstimate.call(navigator.storage).then(function (e) {
      return { quota: S.quota || e.quota, usage: S.usage || e.usage };
    });
  }, 'estimate');
  navigator.storage.persist = hideNative(function persist() { return Promise.resolve(S.persistent); }, 'persist');
  navigator.storage.persisted = hideNative(function persisted() { return Promise.resolve(S.persistent); }, 'persisted');
})();

// --- performance.memory ---
(function () {
  const P = CFG.performance;
  if (!P.memoryEnabled) return;
  const mem = {
    jsHeapSizeLimit: P.jsHeapSizeLimit,
    totalJSHeapSize: P.totalJSHeapSize,
    usedJSHeapSize: P.usedJSHeapSize
  };
  patchProp(performance, 'memory', function () { return mem; });
})();

// --- 字体可见性 ---
// 字体枚举（measureText / fonts.check 一致性）见 patches/fonts.ts，
// 单独成模块是因为它必须同时覆盖两条探测路径，否则两条会互相打脸。
`
}
