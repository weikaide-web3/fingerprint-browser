import type { FingerprintConfig } from '@shared/types'

/** screen / window 尺寸与像素比 */
export function screenPatch(_fp: FingerprintConfig): string {
  return `
// --- screen ---
(function () {
  const S = CFG.screen;
  const proto = Screen.prototype;
  define(proto, 'width', { get: function () { return S.width; } });
  define(proto, 'height', { get: function () { return S.height; } });
  define(proto, 'availWidth', { get: function () { return S.availWidth; } });
  define(proto, 'availHeight', { get: function () { return S.availHeight; } });
  define(proto, 'availLeft', { get: function () { return S.availLeft; } });
  define(proto, 'availTop', { get: function () { return S.availTop; } });
  define(proto, 'colorDepth', { get: function () { return S.colorDepth; } });
  define(proto, 'pixelDepth', { get: function () { return S.pixelDepth; } });
  const orientation = {
    type: S.orientationType,
    angle: S.orientationAngle,
    onchange: null,
    toJSON: function () { return { type: this.type, angle: this.angle }; }
  };
  define(proto, 'orientation', { get: function () { return orientation; } });
  patchProp(window, 'devicePixelRatio', function () { return S.devicePixelRatio; });
})();

// --- window 内外尺寸 ---
// 这里刻意不改写 innerWidth / innerHeight / outerWidth / outerHeight /
// documentElement.clientWidth / offsetHeight / visualViewport。
//
// 原因（本机真实内核实测出来的）：内核按真实视口排版，铺满视口的 fixed 元素
// 高度是引擎给的、JS 改不掉。一旦把 innerHeight 改成配置值，就会出现
//   window.innerHeight = 740（改过的）
//   fixed{inset:0}.clientHeight = 657（引擎真实值）
// 这种 80px 级别的缺口 —— 任何网站放一个全屏 div 量一下就能证明我们改过，
// 比「黄条压了视口」严重得多。
//
// 正确做法在 launcher / injector 里：用 --window-size + CDP Browser.setWindowBounds
// 把真实窗口开成 profile 配置的尺寸，于是真实值本身就等于配置值，无需撒谎。
// 下面只做一件事：万一窗口没能开成配置尺寸（Chrome 会按 profile 记住的位置恢复），
// 就把偏差记下来，让检测页能报出来，而不是悄悄对不上。
(function () {
  const S = CFG.screen;
  if (!S.windowWidth || !S.windowHeight) return;
  window.__fpWindowExpect = { width: S.windowWidth, height: S.windowHeight };
})();
`
}
