import type { FingerprintConfig } from '@shared/types'

/**
 * 自动化痕迹消除 + 真实浏览器应有但自动化环境常缺的信号。
 *
 * 这一层的目标不是「伪装成别人」，而是「别暴露自己是被驱动的」：
 * - ChromeDriver / Playwright 会在 window 上留下 cdc_ / dc_ 属性；
 * - CDP 的 Runtime.enable 会让 console.log(obj) 去序列化对象，从而触发对象 getter
 *   —— 站点正是用这个技巧判断「有没有调试器挂着」，所以先把参数转成字符串；
 * - headless / 后台窗口下 visibilityState、hasFocus 与真人不同；
 * - matchMedia / speechSynthesis / PaymentRequest / MediaCapabilities 缺失本身就是特征。
 */
export function stealthPatch(_fp: FingerprintConfig): string {
  return `
// --- 自动化痕迹清理 ---
(function () {
  const S = CFG.stealth;
  if (!S.enabled || !S.hideAutomationProps) return;
  // ChromeDriver 注入的形如 cdc_adoQpoasnfa76pfcZLmcfl_Array 的属性；
  // 部分驱动还会留下 domAutomationController / __selenium 等。
  const PAT = /^(cdc_|dc_|\\$cdc_|domAutomationController$|__webdriver|__selenium|__driver|__driver_unwrapped|callSelenium|_Selenium_IDE_Recorder|webdriver$)/;
  function scrub(obj) {
    if (!obj) return;
    var names = [];
    try { names = Object.getOwnPropertyNames(obj); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      if (!PAT.test(names[i])) continue;
      try { delete obj[names[i]]; } catch (e) {}
      // window 上有些注入属性删不掉，退一步：枚举时藏起来 + 读取返回 undefined
      try {
        define(obj, names[i], { get: function () { return undefined; }, configurable: true });
      } catch (e2) {}
    }
  }
  scrub(window);
  scrub(navigator);
})();

// --- window.chrome 补全 ---
(function () {
  const S = CFG.stealth;
  if (!S.enabled || !S.chromeObject) return;
  if (!window.chrome) window.chrome = {};
  const c = window.chrome;
  if (!c.app) {
    c.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: hideNative(function getDetails() { return null; }, 'getDetails'),
      getIsInstalled: hideNative(function getIsInstalled() { return false; }, 'getIsInstalled'),
      install: hideNative(function install() { return undefined; }, 'install'),
      runningState: hideNative(function runningState() { return 'cannot_run'; }, 'runningState')
    };
  }
  if (!c.csi) {
    // 真实 Chrome 返回 { start, onload, pageT, documentURL, ... }；
    // 结构存在比数值精确更重要 —— 缺这个函数是自动化环境的典型特征。
    c.csi = hideNative(function csi() {
      return { start: Date.now() - 1200, onload: 0, pageT: 0, documentURL: location.href, startType: 'start', istype: true };
    }, 'csi');
  }
  if (!c.loadTimes) {
    c.loadTimes = hideNative(function loadTimes() {
      return {
        commitLoadTime: Date.now() / 1000,
        connectionInfo: 'h2',
        sslProtocol: 'TLS 1.3',
        dnsCacheEnabled: true,
        vp9Enabled: S.codecs.vp9,
        nativeMessagingEnabled: true
      };
    }, 'loadTimes');
  }
  if (!c.runtime) {
    // 没装扩展时 Chrome 也有 chrome.runtime，但只暴露这些常量对象
    c.runtime = {
      OnInstalledReason: {}, OnRestartRequiredReason: {},
      PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {}
    };
  }
})();

// --- 可见性与焦点：headless / 后台窗口的典型穿帮点 ---
(function () {
  const S = CFG.stealth;
  if (!S.enabled || !S.forceVisible) return;
  define(Document.prototype, 'hidden', { get: function () { return false; } });
  define(Document.prototype, 'visibilityState', { get: function () { return 'visible'; } });
  define(Document.prototype, 'webkitHidden', { get: function () { return false; } });
  define(Document.prototype, 'webkitVisibilityState', { get: function () { return 'visible'; } });
  Document.prototype.hasFocus = hideNative(function hasFocus() { return true; }, 'hasFocus');
  // 刻意不伪造 visibilitychange / focus 事件：真人切前台才有这些事件，
  // 凭空派发反而制造「从没离开过前台」这种不自然的时序。
})();

// --- matchMedia：冷门媒体特性缺失本身就是特征 ---
(function () {
  const S = CFG.stealth;
  if (!S.enabled) return;
  const orig = window.matchMedia;
  if (!orig) return;
  const MAP = {
    'prefers-color-scheme': S.colorScheme === 'system' ? null : S.colorScheme,
    'prefers-reduced-motion': S.prefersReducedMotion ? 'reduce' : 'no-preference',
    'prefers-contrast': S.prefersContrast,
    'prefers-reduced-transparency': 'no-preference',
    'prefers-reduced-data': 'no-preference',
    'forced-colors': S.forcedColors,
    'display-mode': S.displayMode,
    'any-hover': S.anyHover,
    'any-pointer': S.pointer,
    'hover': S.hover,
    'pointer': S.pointer,
    'update': S.update,
    'color-gamut': 'srgb',
    'scripting': 'enabled'
  };

  /**
   * 只处理「纯已知特性 + and」的查询，其它一律交回原生实现。
   * 宁可少接管，也不要因为解析错误给出与内核矛盾的判定。
   */
  function evalQuery(q) {
    const s = String(q).toLowerCase().trim();
    if (!s || /\\bor\\b/.test(s) || /(^|[^a-z-])not\\s*\\(/.test(s)) return null;
    const parts = s.split(/\\s+and\\s+/);
    let all = true
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim().replace(/^[\\s(]+/, '').replace(/[\\s)]+$/, '').trim();
      if (!part) return null;
      const m = /^([a-z][a-z-]*)\\s*(?::\\s*(.+))?$/.exec(part);
      if (!m) return null;
      const name = m[1];
      const val = m[2] ? m[2].trim() : null;
      if (!(name in MAP)) return null;
      const want = MAP[name];
      if (want === null) return null;
      if (val !== null && val !== want) all = false;
    }
    return all;
  }

  window.matchMedia = hideNative(function matchMedia(query) {
    const hit = evalQuery(query);
    if (hit === null) return orig.call(window, query);
    // 用原生实现造一个真正的 MediaQueryList（原型链、事件方法都是真的），
    // 再把 media 改回调用方传入的查询串。
    // 注意：'all' 是媒体类型，不能写成 '(all)' —— 带括号是非法查询，
    // Chrome 会对非法查询返回 matches=false，于是所有判定都被压成 false。
    const mql = orig.call(window, hit ? 'all' : '(min-width: 2147483647px)');
    define(mql, 'media', { get: function () { return String(query); }, configurable: true });
    return mql;
  }, 'matchMedia');
})();

// --- speechSynthesis：空语音列表是 headless 的典型特征 ---
(function () {
  const S = CFG.stealth;
  if (!S.enabled || !window.speechSynthesis) return;
  const proto = typeof SpeechSynthesisVoice !== 'undefined' ? SpeechSynthesisVoice.prototype : Object.prototype;
  const voices = S.voices.map(function (v) {
    const o = Object.create(proto);
    // SpeechSynthesisVoice 的 name/lang/... 在原型上是只读 getter，
    // 直接赋值会在严格模式下抛错 —— 而这一处抛错曾经把后面的
    // PaymentRequest / MediaCapabilities / console 加固整段带走。
    define(o, 'name', { get: function () { return v.name; }, configurable: true });
    define(o, 'lang', { get: function () { return v.lang; }, configurable: true });
    define(o, 'voiceURI', { get: function () { return v.voiceURI; }, configurable: true });
    define(o, 'localService', { get: function () { return v.localService; }, configurable: true });
    define(o, 'default', { get: function () { return v.default; }, configurable: true });
    return o;
  });
  speechSynthesis.getVoices = hideNative(function getVoices() { return voices.slice(); }, 'getVoices');
})();

// --- PaymentRequest.canMakePayments ---
(function () {
  const S = CFG.stealth;
  if (!S.enabled || !S.payment.enabled) return;
  if (typeof window.PaymentRequest === 'undefined') return;
  try {
    window.PaymentRequest.canMakePayments = hideNative(
      function canMakePayments() { return S.payment.canMakePayments; },
      'canMakePayments'
    );
  } catch (e) {}
})();

// --- MediaCapabilities：解码能力必须与真实内核一致（缺 H.264 一眼是 Chromium 快照） ---
(function () {
  const S = CFG.stealth;
  if (!S.enabled || !navigator.mediaCapabilities) return;
  const CODEC = [
    ['avc1', S.codecs.h264],
    ['vp09', S.codecs.vp9],
    ['vp9', S.codecs.vp9],
    ['av01', S.codecs.av1],
    ['vp8', S.codecs.vp8],
    ['mp4a', S.codecs.aac],
    ['aac', S.codecs.aac],
    ['mp3', S.codecs.mp3],
    ['opus', S.codecs.opus]
  ];
  function supported(type) {
    const t = String(type || '').toLowerCase();
    for (let i = 0; i < CODEC.length; i++) {
      if (t.indexOf(CODEC[i][0]) >= 0) return CODEC[i][1];
    }
    return true;
  }
  const orig = navigator.mediaCapabilities.decodingInfo;
  navigator.mediaCapabilities.decodingInfo = hideNative(function decodingInfo(config) {
    const c = (config && config.video) || (config && config.audio) || {};
    const ok = supported(c.contentType);
    // 保留内核对「非法配置」的 TypeError：站点靠这个异常校验参数，
    // 我们只覆盖它给出的结论（supported / powerEfficient / smooth）。
    const base = orig ? orig.call(navigator.mediaCapabilities, config) : Promise.resolve({});
    return Promise.resolve(base).then(function (r) {
      return {
        supported: ok,
        powerEfficient: ok,
        smooth: ok,
        width: (r && r.width) || 0,
        height: (r && r.height) || 0,
        samplingRate: (r && r.samplingRate) || 0,
        channelCount: (r && r.channelCount) || 0
      };
    });
  }, 'decodingInfo');
})();

// --- console 加固 ---
(function () {
  const S = CFG.stealth;
  if (!S.enabled || !S.consoleHardening) return;
  const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table'];
  /**
   * 自己把参数转成字符串，且刻意不读取任何 getter。
   *
   * 关键点：JSON.stringify 会调用 getter，所以不能用它 ——
   * 站点正是把 getter 挂在对象上，看 console.log(obj) 之后有没有被调用，
   * 以此判断「有没有调试器挂着」（CDP 的 Runtime.enable 会让原生 console.log 去序列化对象）。
   * 我们只按 own descriptor 描述对象，访问器一律写成 [Getter/Setter]，
   * 交给原生方法的就只剩一个字符串，CDP 那边不会再碰到任何属性访问。
   */
  function describe(v, depth, seen) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'string') return JSON.stringify(v);
    if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return String(v);
    if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
    if (v instanceof Error) return String(v && v.stack ? v.stack : v);
    if (depth > 2) return '[…]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) {
      const items = [];
      for (let i = 0; i < v.length && i < 20; i++) items.push(describe(v[i], depth + 1, seen));
      return '[' + items.join(', ') + (v.length > 20 ? ', …(' + v.length + ')' : '') + ']';
    }
    let name = 'Object';
    try { if (v.constructor && v.constructor.name) name = v.constructor.name; } catch (e) {}
    let keys = [];
    try { keys = Object.getOwnPropertyNames(v); } catch (e) {}
    const parts = [];
    for (let i = 0; i < keys.length && i < 20; i++) {
      const k = keys[i];
      let d = null;
      try { d = Object.getOwnPropertyDescriptor(v, k); } catch (e) { continue; }
      if (!d) continue;
      // 访问器：只报告存在，绝不读取 —— 这是整个加固的意义
      if (d.get || d.set) { parts.push(k + ': [Getter/Setter]'); continue; }
      parts.push(k + ': ' + describe(d.value, depth + 1, seen));
    }
    return name + ' {' + parts.join(', ') + (keys.length > 20 ? ', …' : '') + '}';
  }
  function plain(v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return String(v);
    const t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return String(v);
    if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
    if (v instanceof Error) return String(v && v.stack ? v.stack : v);
    try {
      return describe(v, 0, new WeakSet());
    } catch (e) { return '[unserializable]'; }
  }
  for (const name of METHODS) {
    const orig = console[name];
    if (typeof orig !== 'function') continue;
    const wrapper = hideNative(function () {
      const args = Array.prototype.slice.call(arguments).map(plain);
      return orig.apply(console, args);
    }, name);
    // length / name 也要跟原生一致，否则 Function.length 一比就露
    try {
      Object.defineProperty(wrapper, 'length', { value: orig.length, configurable: true });
    } catch (e) {}
    console[name] = wrapper;
  }
})();
`
}