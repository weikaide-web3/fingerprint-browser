/**
 * 语言标签与 Accept-Language 的共用规则。
 *
 * 为什么需要单独一个模块：Chrome 的 Accept-Language **不是**一个可以随便填的头，
 * 它是由「语言列表」按固定规则生成的（实测确认）：
 *   列表 [zh-CN, zh, en] → 线上头 "zh-CN,zh;q=0.9,en;q=0.8"
 *   同时 navigator.languages = ["zh-CN","zh","en"]
 * 也就是说 q 值是内核算出来的。把带 q 的完整头塞给 --accept-lang 或
 * CDP 的 acceptLanguage，内核会把它当「语言列表」再算一遍，得到
 * "zh-CN,zh;q=0.9;q=0.9,en;q=0.8;q=0.8" 这种没有任何真实 Chrome 会发的形状，
 * 而且 navigator.languages 也会变成 ["zh-CN","zh;q=0.9",...]。
 *
 * 所以全链路只允许传「裸 tag 列表」，头由本模块按内核规则推导，
 * 保证「配置」「页面」「线上请求头」三处永远同一个值。
 */

/** 单个语言 tag 的合法形状：zh / zh-CN / zh-Hans-CN / en-US-u-nu-latn */
const TAG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/

/**
 * 清洗成「裸 tag 列表」：去掉用户/旧配置里误带的 ;q=、*、空白，去重保序。
 * 非法项直接丢弃而不是抛错 —— 配置里一个坏 tag 不该让整个环境开不起来。
 */
export function sanitizeLanguageTags(raw: readonly string[] | string | null | undefined): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  const out: string[] = []
  for (const item of list) {
    const tag = String(item ?? '')
      .split(';')[0]
      .trim()
    if (!tag || tag === '*') continue
    if (!TAG_RE.test(tag)) continue
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag)
  }
  return out
}

/**
 * 按内核规则从语言列表生成 Accept-Language。
 * 第一个不带 q，之后依次 0.9 / 0.8 / 0.7 …（下限 0.1，再多也不会更低）。
 * 空列表返回 '*'，与内核行为一致。
 */
export function generateAcceptLanguage(tags: readonly string[] | string | null | undefined): string {
  const list = sanitizeLanguageTags(tags)
  if (!list.length) return '*'
  return list
    .map((tag, i) => {
      if (i === 0) return tag
      const q = Math.max(1, 10 - i) / 10
      return `${tag};q=${q.toFixed(1).replace(/\.0$/, '')}`
    })
    .join(',')
}

/** 配置里的 acceptLanguage 是否就是列表推导出来的那个值 */
export function acceptLanguageMatchesLanguages(
  acceptLanguage: string,
  tags: readonly string[] | string | null | undefined
): boolean {
  return acceptLanguage.trim() === generateAcceptLanguage(tags)
}

/**
 * 给 CDP / 启动参数用的值：逗号分隔的裸 tag（绝不能带 q）。
 */
export function languageListArg(tags: readonly string[] | string | null | undefined): string {
  return sanitizeLanguageTags(tags).join(',')
}