/**
 * Chrome 应用商店扩展 ID 解析（纯函数，不碰数据库 / Electron，便于单测）。
 */

/** Chrome 扩展 ID：32 个 a-p 的小写字母（CRX id 字母表） */
const STORE_ID_RE = /^[a-p]{32}$/

/**
 * 从 Chrome 应用商店 URL 或裸 ID 中提取扩展 ID。支持：
 *   https://chromewebstore.google.com/detail/<slug>/<id>
 *   https://chrome.google.com/webstore/detail/<slug>/<id>
 *   裸 32 位 ID
 * 提取不到合法 ID 时抛错。
 */
export function parseStoreId(input: string): string {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('请输入 Chrome 应用商店链接或扩展 ID')
  const noQuery = raw.split(/[?#]/)[0].replace(/\/+$/, '')
  const last = noQuery.split('/').pop() ?? ''
  if (STORE_ID_RE.test(last)) return last
  if (STORE_ID_RE.test(raw)) return raw
  throw new Error('无法识别扩展 ID：请粘贴形如 …/detail/<名称>/<32位ID> 的商店链接')
}

/** 从商店 URL 的 slug 段猜测一个可读名称（拿不到时回退到 ID） */
export function guessNameFromUrl(input: string, id: string): string {
  const noQuery = String(input).split(/[?#]/)[0].replace(/\/+$/, '')
  const segs = noQuery.split('/')
  const slug = segs.length >= 2 ? segs[segs.length - 2] : ''
  if (slug && slug !== 'detail' && !STORE_ID_RE.test(slug)) {
    return decodeURIComponent(slug).replace(/-/g, ' ')
  }
  return id
}

export function storeUrlFor(storeId: string): string {
  return `https://chromewebstore.google.com/detail/${storeId}`
}
