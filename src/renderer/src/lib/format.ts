/** 渲染层通用格式化，多个视图共用 */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  const v = n / 1024 ** i
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatTime(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  return `${Math.round(diff / 86_400_000)} 天前`
}