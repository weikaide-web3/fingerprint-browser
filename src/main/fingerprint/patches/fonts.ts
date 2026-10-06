import type { FingerprintConfig } from '@shared/types'

/**
 * 字体枚举一致性。
 *
 * 网站检测「装了哪些字体」不靠 document.fonts.check（那个太容易改），而是：
 *   1. canvas 里 measureText('mmmmmmmmmmlli', '72px "Some Font", monospace')
 *   2. 与同一文本用 monospace / serif / sans-serif 兜底时的宽度比较
 *   3. 宽度不同 => 该字体存在
 * 所以只改 fonts.check 会被直接打脸：check 说有、measureText 说没有。
 *
 * 实现要点（也是为什么不能凭空造宽度）：
 * 页面还会把同一段文字塞进 <span> 量 offsetWidth 来交叉验证。凭空合成的宽度
 * 与真实排版对不上，反而更可疑。所以这里一律「让内核自己量」，只是把
 * profile 不想暴露的 family 从字体串里摘掉，让浏览器自然回退到兜底字体 ——
 * 量出来的就是真实的兜底宽度，DOM 与 canvas 完全一致。
 */
export function fontsPatch(_fp: FingerprintConfig): string {
  return `
// --- 字体枚举（measureText / CSS font / fonts.check 一致性） ---
(function () {
  const F = CFG.fonts;
  if (F.mode === 'os_default') return;
  const OWNED = new Set(F.families.map(function (f) {
    return String(f).toLowerCase().replace(/["']/g, '').trim();
  }));
  const GENERIC = ['monospace', 'serif', 'sans-serif', 'cursive', 'fantasy', 'system-ui',
    'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong'];

  /** 拆 font shorthand：前缀（style/weight/size）与 family 列表 */
  function parseFont(font) {
    const s = String(font || '');
    const m = /(\\d+(?:\\.\\d+)?)\\s*(px|pt|em|rem|%|vh|vw|ex|ch|cm|mm|in|pc)\\s+/i.exec(s);
    if (!m) return { prefix: '', families: [], raw: s };
    const start = m.index + m[0].length;
    const families = s.slice(start).split(',').map(function (f) {
      return f.toLowerCase().replace(/["']/g, '').trim();
    }).filter(Boolean);
    return { prefix: s.slice(0, start), families: families, raw: s };
  }

  function isGeneric(f) { return GENERIC.indexOf(f) >= 0; }

  /**
   * 重写字体串：把「profile 不拥有」的具体 family 摘掉，只保留拥有的与通用族。
   * 返回 null 表示没有需要处理的 family（原样交给内核）。
   */
  function rewrite(parsed) {
    if (!parsed.prefix || !parsed.families.length) return null;
    let touched = false;
    const kept = [];
    for (const f of parsed.families) {
      if (isGeneric(f) || OWNED.has(f)) { kept.push(f); continue; }
      touched = true; // 不拥有的具体字体：摘掉，让浏览器回退
    }
    if (!touched) return null;
    if (!kept.length) kept.push('sans-serif');
    return parsed.prefix + kept.join(', ');
  }

  if (typeof CanvasRenderingContext2D !== 'undefined') {
    const origMeasure = CanvasRenderingContext2D.prototype.measureText;
    if (origMeasure) {
      CanvasRenderingContext2D.prototype.measureText = hideNative(function measureText(text) {
        const target = rewrite(parseFont(this.font));
        if (!target) return origMeasure.call(this, text);
        const saved = this.font;
        try {
          this.font = target;
          const m = origMeasure.call(this, text);
          this.font = saved;
          return m;
        } catch (e) {
          try { this.font = saved; } catch (e2) {}
          return origMeasure.call(this, text);
        }
      }, 'measureText');
    }
  }

  // CSS font 同样影响 <span>.offsetWidth 这类交叉验证，走同一套摘除逻辑
  if (typeof CSSStyleDeclaration !== 'undefined') {
    const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'font');
    if (d && d.set) {
      define(CSSStyleDeclaration.prototype, 'font', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: hideNative(function set(value) {
          const target = rewrite(parseFont(value));
          d.set.call(this, target || value);
        }, 'set font')
      });
    }
  }

  // document.fonts.check 必须与上面的度量给出同一个答案
  if (document.fonts && typeof document.fonts.check === 'function') {
    const origCheck = document.fonts.check;
    document.fonts.check = hideNative(function check(font, text) {
      const p = parseFont(font);
      const specific = p.families.filter(function (f) { return !isGeneric(f); });
      if (specific.length) return specific.some(function (f) { return OWNED.has(f); });
      return origCheck.call(document.fonts, font, text == null ? 'BESbswy' : text);
    }, 'check');
  }
})();
`
}
