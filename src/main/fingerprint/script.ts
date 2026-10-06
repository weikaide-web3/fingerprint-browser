import type { FingerprintConfig } from '@shared/types'
import { normalizeFingerprint } from './generator'
import { navigatorPatch } from './patches/navigator'
import { screenPatch } from './patches/screen'
import { webglPatch } from './patches/webgl'
import { webgpuPatch } from './patches/webgpu'
import { canvasPatch } from './patches/canvas'
import { fontsPatch } from './patches/fonts'
import { audioPatch } from './patches/audio'
import { webrtcPatch } from './patches/webrtc'
import { miscPatch } from './patches/misc'
import { stealthPatch } from './patches/stealth'

/** 注入到每个新文档的公共引导代码：原生函数伪装 + 确定性随机源 */
const PRELUDE = `
const CFG = __CFG__;
const patchedToString = new WeakMap();
// 记录所有被改写过的函数名：检测页需要逐个验证它们仍伪装成 native code，
// 只抽查两三处是不够的 —— BotGuard 会系统性验证 native 标记。
const patchedNames = [];
const origFnToString = Function.prototype.toString;
Function.prototype.toString = hideNative(function toString() {
  if (patchedToString.has(this)) return patchedToString.get(this);
  return origFnToString.call(this);
}, 'toString');
function hideNative(fn, name) {
  patchedToString.set(fn, 'function ' + name + '() { [native code] }');
  if (name) patchedNames.push(name);
  return fn;
}
function define(obj, prop, descriptor) {
  try {
    // getter / setter 必须一起伪装成 native code。
    // 只伪装方法而漏掉访问器是最常见的穿帮：站点只要
    // Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get.toString()
    // 就能看到我们写的 JS 源码。
    const d = { ...descriptor };
    if (typeof d.get === 'function') d.get = hideNative(d.get, 'get ' + String(prop));
    if (typeof d.set === 'function') d.set = hideNative(d.set, 'set ' + String(prop));
    Object.defineProperty(obj, prop, d)
  } catch (e) {
    // 静默失败曾长期掩盖「改到了错误的原型」这类 bug：错误记到 Symbol 键上，
    // 普通属性扫描看不到，但集成测试与排查时能读出来。
    try {
      const k = Symbol.for('fpb.define.errors');
      if (!window[k]) window[k] = [];
      window[k].push(String(prop) + ':' + e);
    } catch (e2) {}
  }
}
/** 找到 prop 真正定义在哪个对象上（真实浏览器里 navigator.* 都在 Navigator.prototype） */
function ownerOf(obj, prop) {
  let o = obj;
  let depth = 0;
  while (o && depth < 12) {
    if (Object.prototype.hasOwnProperty.call(o, prop)) return o;
    o = Object.getPrototypeOf(o);
    depth++;
  }
  return null;
}
/**
 * 把属性改写安装到「原生定义它的那个对象」上。
 *
 * 直接 define(navigator, 'userAgent', ...) 会在实例上留下 own property，
 * 而真实 Chrome 的 navigator 上没有任何 own 数据/访问属性 ——
 * navigator.hasOwnProperty('userAgent') 返回 true 就等于自曝。
 * 所以这里顺着原型链找到原生定义点，在那里覆盖，并清掉实例上的残留。
 */
function patchProp(obj, prop, getter, setter) {
  const owner = ownerOf(obj, prop) || obj;
  if (owner !== obj) {
    try { if (Object.prototype.hasOwnProperty.call(obj, prop)) delete obj[prop]; } catch (e) {}
  }
  const desc = { get: getter, configurable: true, enumerable: true };
  if (typeof setter === 'function') desc.set = setter;
  else {
    // 原生是 accessor 却没有 setter，说明该属性本来就只读；
    // 保留一个静默 setter 会让「赋值不报错」与真实行为不一致，所以维持只读。
    const prev = Object.getOwnPropertyDescriptor(owner, prop);
    if (prev && prev.set) desc.set = hideNative(function set(v) {}, 'set ' + String(prop));
  }
  define(owner, prop, desc);
}
function strHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedRand = mulberry32(strHash(String(CFG.seed)));
function jitter(value, amount) {
  if (!amount) return value;
  return value + Math.round((seedRand() * 2 - 1) * amount);
}
`;

/**
 * 生成 document-start 注入脚本。
 * 所有补丁共享同一个 seed，保证同一 profile 每次输出完全一致。
 *
 * 每个补丁单独包一层 try/catch：补丁是用模板字符串拼出来的 JS，
 * 一处运行时异常（例如给只读 getter 赋值）会把后面所有补丁一起带走，
 * 而界面上完全看不出来 —— 只有内核里的信号是裸的。
 * 隔离之后失败点会被记进 Symbol.for('fpb.patch.errors')，检测页据此直接判失败。
 */
const PATCH_NAMES = [
  'navigator',
  'screen',
  'webgl',
  'webgpu',
  'canvas',
  'fonts',
  'audio',
  'webrtc',
  'misc',
  'stealth'
] as const

function isolate(name: string, code: string): string {
  return (
    `try {\n${code}\n} catch (e) { try {\n` +
    `const k = Symbol.for('fpb.patch.errors');\n` +
    `const arr = window[k] || (window[k] = []);\n` +
    `arr.push(${JSON.stringify(name)} + ':' + (e && e.message ? e.message : String(e)));\n` +
    `} catch (e2) {} }`
  )
}

export function buildFingerprintScript(input: FingerprintConfig): string {
  // 旧环境读出来的配置可能缺新加的分段，先补齐再拼脚本
  const fp = normalizeFingerprint(input)
  const cfg = {
    seed: fp.seed,
    ua: fp.ua,
    ch: fp.clientHints,
    screen: fp.screen,
    webgl: fp.webgl,
    webgpu: fp.webgpu,
    canvas: fp.canvas,
    audio: fp.audio,
    fonts: fp.fonts,
    webrtc: fp.webrtc,
    media: fp.mediaDevices,
    battery: fp.battery,
    hardware: fp.hardware,
    language: fp.language,
    storage: fp.storage,
    connection: fp.connection,
    privacy: fp.privacy,
    plugins: fp.plugins,
    permissions: fp.permissions,
    stealth: fp.stealth,
    performance: fp.performance
  }
  const parts = [
    navigatorPatch(fp),
    screenPatch(fp),
    webglPatch(fp),
    webgpuPatch(fp),
    canvasPatch(fp),
    // fontsPatch 必须在 canvasPatch 之后：它包装已加过噪声的 measureText，
    // 顺序反了会让「字体回退宽度」与「文本噪声」两条链互相覆盖。
    fontsPatch(fp),
    audioPatch(fp),
    webrtcPatch(fp),
    miscPatch(fp),
    // stealthPatch 放最后：它包装 console 与 matchMedia 等原生入口，
    // 前面的补丁若失败会在 console 里留痕，顺序反了会把痕迹本身也吞掉。
    stealthPatch(fp)
  ]
  if (parts.length !== PATCH_NAMES.length) {
    throw new Error('注入补丁与 PATCH_NAMES 数量不一致，检测页将无法定位失败补丁')
  }
  // 幂等守卫：同一文档被多次注册时只应用一次，避免噪声叠加
  // 末尾把「被改写函数清单」与「补丁异常清单」暴露出来：
  // 前者供检测页逐个验证 native 伪装是否完整，后者让静默失败变成可见失败。
  const body = parts.map((code, i) => isolate(PATCH_NAMES[i], code)).join('\n')
  return (
    `(function () {\n"use strict";\nif (window.__fpInjected) return;\nwindow.__fpInjected = true;\n` +
    `${PRELUDE.replace('__CFG__', JSON.stringify(cfg))}\n${body}\n` +
    `try { window.__fpbPatched = patchedNames.slice(); } catch (e) {}\n` +
    `try { const k = Symbol.for('fpb.patch.errors'); window.__fpbPatchErrors = (window[k] || []).slice(); } catch (e) {}\n` +
    `})();`
  )
}
