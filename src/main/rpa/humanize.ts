import type { HumanizeConfig } from '@shared/humanize'

/**
 * 人类行为的数学部分：纯函数、可注入随机源，因此能完整单测。
 *
 * 关键点：真实鼠标轨迹不是直线，而是「起点加速 → 中段最快 → 终点减速并微调」，
 * 且间隔分布近似对数正态。这里用三次贝塞尔 + 时间重映射来复现，
 * 而不是等分直线 —— 等分直线的速度剖面本身就是机器人特征。
 */

export interface Point {
  x: number
  y: number
}

export type Rng = () => number

/** mulberry32：可复现的 32 位 PRNG（同一 seed 得到同一轨迹，便于回放与测试） */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function randRange(rng: Rng, [min, max]: [number, number]): number {
  if (!(max > min)) return Math.max(0, min)
  return min + rng() * (max - min)
}

/** 对数正态抖动：真实间隔不是均匀分布，而是长尾 —— 大部分快、偶尔很慢 */
export function jitter(rng: Rng, [min, max]: [number, number]): number {
  if (!(max > min)) return Math.max(0, min)
  const u = Math.min(0.999999, Math.max(0.000001, rng()))
  // u^1.8：取值整体贴近下界，偶尔拖出很长的尾。
  // 注意指数必须 > 1 —— 小于 1 会把分布推向「普遍偏慢」，反而不像人。
  const shaped = Math.pow(u, 1.8)
  // 延迟绝不能为负：负数会让 sleep(-x) 变成同步执行，节奏全乱
  return Math.max(0, Math.round(min + shaped * (max - min)))
}

/**
 * 在元素矩形内取一个落点。
 * 真实点击不会正中中心：中心附近概率高，但边缘也常见。
 * 用「以中心为均值的高斯 + 边界裁剪」，并刻意避开四边 2px（点不到）。
 */
export function clickPoint(box: { x: number; y: number; width: number; height: number }, rng: Rng): Point {
  const pad = Math.min(2, box.width / 6, box.height / 6)
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const rx = Math.max(0, box.width / 2 - pad)
  const ry = Math.max(0, box.height / 2 - pad)
  const u1 = Math.max(1e-9, rng())
  const u2 = rng()
  const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  const g2 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2)
  const clamp = (v: number, r: number): number => Math.max(-r, Math.min(r, v))
  return {
    x: Math.round((cx + clamp(g * rx * 0.42, rx)) * 100) / 100,
    y: Math.round((cy + clamp(g2 * ry * 0.42, ry)) * 100) / 100
  }
}

/**
 * 生成鼠标轨迹：三次贝塞尔 + 时间重映射。
 * 返回 [{x,y,t}]，t 是相对起点的毫秒数。
 */
export function mousePath(from: Point, to: Point, cfg: HumanizeConfig, rng: Rng): (Point & { t: number })[] {
  const steps = Math.max(2, Math.round(randRange(rng, cfg.mouseSteps)))
  const total = Math.max(1, Math.round(randRange(rng, cfg.mouseDurationMs)))
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)

  // 距离很短时不需要复杂曲线，人也不会画大弧
  if (dist < 12) {
    const out: (Point & { t: number })[] = []
    const n = Math.min(steps, 4)
    for (let i = 1; i <= n; i += 1) {
      const p = i / n
      out.push({ x: from.x + dx * p, y: from.y + dy * p, t: Math.round(total * p) })
    }
    return out
  }

  // 控制点垂直于连线方向偏移，弧度随距离增长但被限制，避免夸张的 S 形
  const nx = -dy / dist
  const ny = dx / dist
  const bow = (rng() * 2 - 1) * Math.min(dist * 0.22, 90)
  const c1: Point = {
    x: from.x + dx * 0.28 + nx * bow * (0.4 + rng() * 0.5),
    y: from.y + dy * 0.28 + ny * bow * (0.4 + rng() * 0.5)
  }
  const c2: Point = {
    x: from.x + dx * 0.72 + nx * bow * (rng() * 0.6 - 0.1),
    y: from.y + dy * 0.72 + ny * bow * (rng() * 0.6 - 0.1)
  }

  const bezier = (p: number): Point => {
    const q = 1 - p
    const a = q * q * q
    const b = 3 * q * q * p
    const c = 3 * q * p * p
    const d = p * p * p
    return { x: a * from.x + b * c1.x + c * c2.x + d * to.x, y: a * from.y + b * c1.y + c * c2.y + d * to.y }
  }

  // 时间分配：真实鼠标是「起步慢 → 中段最快 → 收尾减速并微调」。
  // 位置按等分 p 采样，所以每步耗时必须与瞬时速度成反比 ——
  // 若按线性或按 p 的幂直接映射，速度剖面会反过来（起步最快），那正是机器人特征。
  const peak = 0.42 + rng() * 0.16 // 最快点略偏前：人常常冲过目标一点再回缩
  const k = Math.log(0.5) / Math.log(peak) // 让 sin 峰值正好落在 p = peak
  const speedAt = (p: number): number => 0.25 + 0.75 * Math.sin(Math.PI * Math.pow(p, k))

  const weights: number[] = []
  let sum = 0
  for (let i = 1; i <= steps; i += 1) {
    const w = 1 / speedAt(i / steps)
    weights.push(w)
    sum += w
  }

  const pts: (Point & { t: number })[] = []
  let prevT = 0
  let acc = 0
  for (let i = 1; i <= steps; i += 1) {
    const p = i / steps
    const pt = bezier(p)
    acc += (total * weights[i - 1]) / sum
    // 时间必须单调不减，且至少 1ms 一步（同一毫秒的 move 会被内核合并）
    const t = Math.max(prevT + 1, Math.round(acc))
    prevT = t
    // 末端抖动：人手在目标附近有 1-2px 的微调
    const amp = p > 0.82 ? 1.1 : 0
    pts.push({
      x: Math.round((pt.x + (amp ? (rng() * 2 - 1) * amp : 0)) * 100) / 100,
      y: Math.round((pt.y + (amp ? (rng() * 2 - 1) * amp : 0)) * 100) / 100,
      t
    })
  }
  pts[pts.length - 1] = { x: to.x, y: to.y, t: prevT }
  return pts
}

/**
 * 逐字符输入的节奏。
 * 空格与标点前后偏慢，同键连打反而更快 —— 与真人手指节奏一致。
 */
export function typingDelays(text: string, cfg: HumanizeConfig, rng: Rng): number[] {
  const out: number[] = []
  let prev = ''
  for (const ch of text) {
    let [lo, hi] = cfg.charDelayMs
    if (ch === ' ') {
      lo *= 1.5
      hi *= 1.7
    } else if (',.!?;:'.includes(ch)) {
      lo *= 2.2
      hi *= 3.2
    } else if (ch === prev) {
      lo *= 0.55
      hi *= 0.7
    }
    out.push(jitter(rng, [lo, hi]))
    prev = ch
  }
  return out
}

export interface TypoEdit {
  /** 在这个字符下标处打错 */
  at: number
  wrong: string
  backspaces: number
}

/** 键盘上相邻的键，用来造出可信的错字 */
const NEIGHBORS: Record<string, string> = {
  a: 'sq',
  s: 'adwx',
  d: 'sfer',
  f: 'drtg',
  g: 'ftyh',
  h: 'gryuj',
  j: 'huik',
  k: 'jiol',
  l: 'kop',
  q: 'wa',
  w: 'qase',
  e: 'wsdr',
  r: 'etdf',
  t: 'rfyg',
  y: 'tghu',
  u: 'yhji',
  i: 'ujko',
  o: 'iklp',
  p: 'ol',
  z: 'xs',
  x: 'zscd',
  c: 'xdev',
  v: 'cfvb',
  b: 'vgbn',
  n: 'bhnm',
  m: 'n,'
}

/**
 * 决定在哪些位置打错字。
 * 只规划「打错 → 回删」的编辑序列，最终文本不变，所以业务安全。
 */
export function planTypos(text: string, rng: Rng, chance = 0.06): TypoEdit[] {
  const out: TypoEdit[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const near = NEIGHBORS[ch.toLowerCase()]
    if (!near || ch !== ch.toLowerCase()) continue
    if (rng() > chance) continue
    out.push({ at: i, wrong: near[Math.floor(rng() * near.length)], backspaces: 1 })
  }
  return out
}

/** 滚动步长：真实滚轮是一次几十像素、带惯性衰减，而不是瞬间 scrollTo */
export function scrollSteps(distance: number, rng: Rng): number[] {
  const out: number[] = []
  let left = distance
  let guard = 0
  while (Math.abs(left) > 4 && guard < 40) {
    const unit = 40 + rng() * 120
    const step = Math.sign(left) * Math.min(Math.abs(left), unit)
    out.push(Math.round(step))
    left -= step
    guard += 1
  }
  return out
}

/** 动作之间的随机停顿 */
export function actionGap(cfg: HumanizeConfig, rng: Rng): number {
  if (!cfg.enabled) return 0
  return jitter(rng, cfg.actionGapMs)
}