/**
 * 极简 cron 解析器（5 字段：分 时 日 月 周）。
 * 支持：星号、数字、a-b 范围、a,b,c 列表、步长（如 0/15）。
 * 不依赖第三方库，够用且可在单测里完整覆盖。
 */

export interface CronFields {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7] // day of week (0 and 7 both = Sunday)
]

function parseField(field: string, range: [number, number]): number[] {
  const [min, max] = range
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? Number(stepMatch[2]) : 1
    if (!Number.isInteger(step) || step <= 0) throw new Error(`非法步长：${part}`)
    const body = stepMatch ? stepMatch[1] : part
    let lo = min
    let hi = max
    if (body !== '*') {
      const rangeMatch = body.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        lo = Number(rangeMatch[1])
        hi = Number(rangeMatch[2])
      } else if (/^\d+$/.test(body)) {
        lo = hi = Number(body)
      } else {
        throw new Error(`无法解析 cron 字段：${part}`)
      }
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 字段越界：${part}（允许 ${min}-${max}）`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  if (!out.size) throw new Error('cron 字段为空')
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron 需要 5 个字段，实际 ${parts.length} 个：${expr}`)
  const fields = parts.map((p, i) => parseField(p, RANGES[i]))
  // 周日 7 归一为 0
  const dow = fields[4].map((d) => (d === 7 ? 0 : d))
  return {
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: [...new Set(dow)].sort((a, b) => a - b)
  }
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

/**
 * 给定 cron 和起始时间，返回下一个匹配的时间戳（精确到分钟）。
 * 逐分钟推进，最多找 366 天，找不到返回 null（例如 2 月 30 日）。
 */
export function nextRun(expr: string, from = Date.now()): number | null {
  const f = parseCron(expr)
  const dowSet = new Set(f.dayOfWeek)
  const domSet = new Set(f.dayOfMonth)
  const monthSet = new Set(f.month)
  const hourSet = new Set(f.hour)
  const minuteSet = new Set(f.minute)

  // 对齐到下一分钟
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)

  const limit = from + 366 * 24 * 60 * 60 * 1000
  while (d.getTime() <= limit) {
    const month = d.getMonth() + 1
    const dom = d.getDate()
    const dow = d.getDay()
    const hour = d.getHours()
    const minute = d.getMinutes()
    if (!monthSet.has(month)) {
      // 跳到下个月 1 号 00:00
      d.setDate(1)
      d.setHours(0, 0, 0, 0)
      d.setMonth(d.getMonth() + 1)
      continue
    }
    // day 匹配：标准 cron 里 dom 和 dow 都受限时任一匹配即可（OR），否则 AND
    const domRestricted = f.dayOfMonth.length < 31
    const dowRestricted = f.dayOfWeek.length < 7
    const dayOk = domRestricted && dowRestricted ? domSet.has(dom) || dowSet.has(dow) : domSet.has(dom) && dowSet.has(dow)
    if (!dayOk) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!hourSet.has(hour)) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!minuteSet.has(minute)) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d.getTime()
  }
  return null
}

/** 人类可读描述（粗略） */
export function describeCron(expr: string): string {
  if (!isValidCron(expr)) return '无效的 cron'
  const f = parseCron(expr)
  const every = (arr: number[], full: number) => (arr.length === full ? '*' : arr.join(','))
  return `分=${every(f.minute, 60)} 时=${every(f.hour, 24)} 日=${every(f.dayOfMonth, 31)} 月=${every(f.month, 12)} 周=${every(f.dayOfWeek, 7)}`
}
