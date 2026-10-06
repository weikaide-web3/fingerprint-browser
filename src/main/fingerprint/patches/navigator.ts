import type { FingerprintConfig } from '@shared/types'

/** navigator 相关指纹：webdriver / UA / 语言 / 硬件 / 插件 / 权限 */
export function navigatorPatch(_fp: FingerprintConfig): string {
  return `
// --- navigator ---
// 全部走 patchProp：真实 Chrome 的 navigator 实例上没有 own 属性，
// 所有属性都定义在 Navigator.prototype 上。直接在实例上覆盖，
// 会让 navigator.hasOwnProperty('userAgent') 变成 true —— 一眼假。
patchProp(Navigator.prototype, 'webdriver', function () { return false; });
patchProp(navigator, 'userAgent', function () { return CFG.ua.ua; });
patchProp(navigator, 'appVersion', function () { return CFG.ua.ua.replace(/^Mozilla\\//, ''); });
patchProp(navigator, 'platform', function () { return CFG.hardware.platform; });
patchProp(navigator, 'language', function () { return CFG.language.languages[0]; });
patchProp(navigator, 'languages', function () { return CFG.language.languages.slice(); });
patchProp(navigator, 'hardwareConcurrency', function () { return CFG.hardware.hardwareConcurrency; });
patchProp(navigator, 'deviceMemory', function () { return CFG.hardware.deviceMemory; });
patchProp(navigator, 'maxTouchPoints', function () { return CFG.hardware.maxTouchPoints; });
patchProp(navigator, 'doNotTrack', function () { return CFG.privacy.dnt ? '1' : null; });
patchProp(navigator, 'globalPrivacyControl', function () { return CFG.privacy.gpc; });

// chrome 对象（Chromium 必须存在，缺失即暴露自动化）
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = {};
if (!window.chrome.csi) window.chrome.csi = hideNative(function csi() { return {}; }, 'csi');
if (!window.chrome.loadTimes) window.chrome.loadTimes = hideNative(function loadTimes() { return {}; }, 'loadTimes');

// plugins / mimeTypes
(function () {
  if (CFG.plugins.mode !== 'custom') return;
  function makePlugin(p) {
    // 用真实原型造对象：toString() / instanceof 才会得到 [object Plugin]，
    // 属性一律用访问器（真实 Plugin 的 name/description/filename 都在 Plugin.prototype 上）
    const obj = Object.create(Plugin.prototype);
    define(obj, 'name', { get: function () { return p.name; }, configurable: true });
    define(obj, 'description', { get: function () { return p.description; }, configurable: true });
    define(obj, 'filename', { get: function () { return p.filename; }, configurable: true });
    define(obj, 'length', { get: function () { return 0; }, configurable: true });
    return obj;
  }
  const plugins = CFG.plugins.plugins.map(makePlugin);
  const mimeTypes = CFG.plugins.mimeTypes.map(function (m) {
    const obj = Object.create(MimeType.prototype);
    define(obj, 'type', { get: function () { return m.type; }, configurable: true });
    define(obj, 'suffixes', { get: function () { return m.suffixes; }, configurable: true });
    define(obj, 'description', { get: function () { return m.description; }, configurable: true });
    define(obj, 'enabledPlugin', { get: function () { return plugins[0] || null; }, configurable: true });
    return obj;
  });
  // PluginArray / MimeTypeArray 的下标与 length 在真实 Chrome 里定义在原型上，
  // 实例本身没有 own 属性 —— 所以这里也走 patchProp 而不是直接赋值。
  function shapeArray(proto, list) {
    const obj = Object.create(proto);
    for (let i = 0; i < list.length; i++) {
      (function (idx) {
        define(proto, String(idx), { get: function () { return list[idx]; }, configurable: true });
      })(i);
    }
    patchProp(obj, 'length', function () { return list.length; });
    obj.item = hideNative(function item(i) { return list[i] || null; }, 'item');
    obj.namedItem = hideNative(function namedItem(n) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].name === n || list[i].type === n) return list[i];
      }
      return null;
    }, 'namedItem');
    return obj;
  }
  const pluginArray = shapeArray(PluginArray.prototype, plugins);
  const mimeArray = shapeArray(MimeTypeArray.prototype, mimeTypes);
  patchProp(navigator, 'plugins', function () { return pluginArray; });
  patchProp(navigator, 'mimeTypes', function () { return mimeArray; });
})();

// permissions.query 一致性
(function () {
  const P = CFG.permissions || { fallback: 'default', entries: {}, enforceKnownNames: true };
  const origQuery = navigator.permissions && navigator.permissions.query;
  if (!origQuery) return;

  // Chrome 认识的权限名。查一个不存在的 name 必须 reject TypeError，
  // 返回一个对象是自动化框架最常见的破绽之一。
  const KNOWN = [
    'accelerometer', 'accessibility-events', 'ambient-light-sensor', 'background-sync',
    'bluetooth', 'camera', 'clipboard-read', 'clipboard-write', 'geolocation',
    'gyroscope', 'magnetometer', 'microphone', 'midi', 'notifications',
    'payment-handler', 'persistent-storage', 'push', 'speaker-selection',
    'idle-detection', 'local-fonts', 'window-management'
  ];
  // 会弹窗的权限在未决定时 Chrome 返回 'prompt'，其它权限返回 'default'
  const PROMPTABLE = ['geolocation', 'camera', 'microphone', 'midi', 'local-fonts', 'window-management', 'persistent-storage'];

  function stateFor(name) {
    if (Object.prototype.hasOwnProperty.call(P.entries, name)) return P.entries[name];
    return P.fallback || 'default';
  }

  function status(name, state) {
    const obj = { name: name, state: state, onchange: null };
    try {
      Object.setPrototypeOf(obj, PermissionStatus.prototype);
    } catch (e) {}
    obj.addEventListener = function () {};
    obj.removeEventListener = function () {};
    return obj;
  }

  navigator.permissions.query = hideNative(function query(desc) {
    const name = desc && desc.name;
    if (!name) return Promise.reject(new TypeError("Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': Required member is undefined."));
    if (P.enforceKnownNames && KNOWN.indexOf(name) < 0) {
      return Promise.reject(new TypeError("Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': The value '" + name + "' is not one of the allowed values."));
    }
    let state = stateFor(name);
    // 用户配的是 'default' 但这项权限在 Chrome 里本该报 'prompt'，按真实行为修正
    if (state === 'default' && PROMPTABLE.indexOf(name) >= 0) state = 'prompt';
    return Promise.resolve(status(name, state));
  }, 'query');

  // request / revoke：保持原生行为，但状态要与 query 一致
  if (navigator.permissions.request) {
    navigator.permissions.request = hideNative(function request(desc) {
      return origQuery.call(navigator.permissions, desc);
    }, 'request');
  }
})();
`
}
