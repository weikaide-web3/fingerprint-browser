import { describe, it, expect } from 'vitest'
import {
  actionGap,
  clickPoint,
  hashSeed,
  jitter,
  makeRng,
  mousePath,
  planTypos,
  scrollSteps,
  typingDelays,
  type Point
} from '../../src/main/rpa/humanize'
import { HUMANIZE_PRESETS, presetConfig, DEFAULT_HUMANIZE } from '@shared/humanize'

/**
 * 人类化行为的数学部分单测。
 * 这里不碰内核，只验证「生成的东西像不像人」—— 真实事件流在 rpa-live 里验。
 */

const std = HUMANIZE_PRESETS.standard

describe('随机源', () => {
  it('同一 seed 得到同一序列（可复现，便于回放与测试）', () => {
    const a = makeRng(hashSeed('abc'))
    const b = makeRng(hashSeed('abc'))
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('不同 seed 得到不同序列', () => {
    expect(makeRng(hashSeed('abc'))()).not.toBe(makeRng(hashSeed('abd'))())
  })

  it('输出落在 [0,1)', () => {
    const rng = makeRng(1234)
    for (let i = 0; i < 500; i += 1) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('hashSeed 稳定且不碰撞', () => {
    expect(hashSeed('')).toBe(hashSeed(''))
    const seeds = new Set<number>()
    for (let i = 0; i < 200; i += 1) seeds.add(hashSeed(`profile-${i}`))
    expect(seeds.size).toBe(200)
  })
})

describe('抖动分布', () => {
  it('jitter 始终落在区间内', () => {
    const rng = makeRng(7)
    for (let i = 0; i < 300; i += 1) {
      const v = jitter(rng, [100, 900])
      expect(v).toBeGreaterThanOrEqual(100)
      expect(v).toBeLessThanOrEqual(900)
    }
  })

  it('jitter 是长尾分布：中位数明显小于区间中点', () => {
    const rng = makeRng(11)
    const vals: number[] = []
    for (let i = 0; i < 2000; i += 1) vals.push(jitter(rng, [100, 900]))
    vals.sort((a, b) => a - b)
    const median = vals[Math.floor(vals.length / 2)]
    // 均匀分布的中位数会是 500；真实间隔应该偏小、右尾长
    expect(median).toBeLessThan(430)
    expect(vals[vals.length - 1]).toBeGreaterThan(700)
  })

  it('退化区间不会崩，也不会产生负数', () => {
    const rng = makeRng(3)
    expect(jitter(rng, [50, 50])).toBe(50)
    expect(jitter(rng, [10, 0])).toBe(10)
    expect(jitter(rng, [-5, 0])).toBe(0)
  })
})

describe('点击落点', () => {
  const box = { x: 100, y: 200, width: 120, height: 40 }

  it('始终落在元素内', () => {
    const rng = makeRng(99)
    for (let i = 0; i < 400; i += 1) {
      const p = clickPoint(box, rng)
      expect(p.x).toBeGreaterThanOrEqual(box.x)
      expect(p.x).toBeLessThanOrEqual(box.x + box.width)
      expect(p.y).toBeGreaterThanOrEqual(box.y)
      expect(p.y).toBeLessThanOrEqual(box.y + box.height)
    }
  })

  it('不会每次都落在正中（这正是机器人特征）', () => {
    const rng = makeRng(5)
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const seen = new Set<string>()
    for (let i = 0; i < 60; i += 1) {
      const p = clickPoint(box, rng)
      seen.add(`${p.x},${p.y}`)
      if (p.x === center.x && p.y === center.y) throw new Error('不应该正好命中中心')
    }
    expect(seen.size).toBeGreaterThan(40)
  })

  it('分布集中在中心附近，但不是全部', () => {
    const rng = makeRng(2024)
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    let near = 0
    const n = 1000
    for (let i = 0; i < n; i += 1) {
      const p = clickPoint(box, rng)
      if (Math.abs(p.x - center.x) <= box.width * 0.25 && Math.abs(p.y - center.y) <= box.height * 0.25) near += 1
    }
    expect(near / n).toBeGreaterThan(0.5)
    expect(near / n).toBeLessThan(0.98)
  })

  it('极小元素也不会算出 NaN 或越界', () => {
    const p = clickPoint({ x: 10, y: 10, width: 1, height: 1 }, makeRng(1))
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.y)).toBe(true)
  })
})

describe('鼠标轨迹', () => {
  const from: Point = { x: 10, y: 10 }
  const to: Point = { x: 610, y: 410 }

  it('终点必须精确落在目标上', () => {
    const pts = mousePath(from, to, std, makeRng(42))
    const last = pts[pts.length - 1]
    expect(last.x).toBe(to.x)
    expect(last.y).toBe(to.y)
  })

  it('时间单调递增，且总耗时在配置区间内', () => {
    for (let s = 0; s < 40; s += 1) {
      const pts = mousePath(from, to, std, makeRng(s))
      for (let i = 1; i < pts.length; i += 1) expect(pts[i].t).toBeGreaterThan(pts[i - 1].t)
      const total = pts[pts.length - 1].t
      expect(total).toBeGreaterThanOrEqual(std.mouseDurationMs[0])
      expect(total).toBeLessThanOrEqual(std.mouseDurationMs[1])
    }
  })

  it('不是直线：中途点明显偏离连线', () => {
    const pts = mousePath(from, to, std, makeRng(hashSeed('curve')))
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy)
    let maxDev = 0
    for (const p of pts) {
      const dev = Math.abs((p.x - from.x) * dy - (p.y - from.y) * dx) / len
      maxDev = Math.max(maxDev, dev)
    }
    expect(maxDev).toBeGreaterThan(5)
  })

  it('速度剖面是「慢-快-慢」：首尾步速小于中段', () => {
    const pts = mousePath(from, to, std, makeRng(777))
    const speed = (i: number): number =>
      Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / (pts[i].t - pts[i - 1].t)
    const n = pts.length
    const early = speed(1)
    const mid = speed(Math.floor(n / 2))
    const late = speed(n - 1)
    expect(mid).toBeGreaterThan(early)
    expect(mid).toBeGreaterThan(late)
  })

  it('短距离走简化路径，不画大弧', () => {
    const pts = mousePath({ x: 100, y: 100 }, { x: 105, y: 103 }, std, makeRng(3))
    expect(pts.length).toBeLessThanOrEqual(4)
    expect(pts[pts.length - 1].x).toBe(105)
    expect(pts[pts.length - 1].y).toBe(103)
  })

  it('同一 seed 得到完全相同的轨迹（可复现）', () => {
    expect(mousePath(from, to, std, makeRng(hashSeed('same')))).toEqual(mousePath(from, to, std, makeRng(hashSeed('same'))))
  })
})

describe('打字节奏', () => {
  it('每个字符一个延迟', () => {
    const cfg = { ...std, charDelayMs: [50, 200] as [number, number] }
    const d = typingDelays('hello world', cfg, makeRng(8))
    expect(d.length).toBe(11)
    for (const v of d) expect(v).toBeGreaterThanOrEqual(50)
  })

  it('空格与标点比字母慢，同键连打比单个字母快', () => {
    // 区间取成同一个值：jitter 退化为定值，这样倍率差异就是可断言的确定值
    const cfg = { ...std, charDelayMs: [100, 100] as [number, number] }
    const [letter, space, comma, period, plainAgain, dup] = typingDelays('a ,.aa', cfg, makeRng(12345))
    expect(letter).toBe(100)
    expect(space).toBeGreaterThan(letter)
    expect(comma).toBeGreaterThan(space)
    // 逗号与句号同属标点，只保证都明显慢于字母
    expect(period).toBeGreaterThan(letter)
    expect(plainAgain).toBe(letter)
    // 连续同一个键：手指不用换位置，反而更快
    expect(dup).toBeLessThan(letter)
  })

  it('空字符串得到空数组', () => {
    expect(typingDelays('', std, makeRng(1))).toEqual([])
  })
})

describe('打字纠错', () => {
  it('错字只落在有相邻键的字母上，且是真实相邻键', () => {
    const text = 'hello world password'
    const typos = planTypos(text, makeRng(2024), 0.5)
    expect(typos.length).toBeGreaterThan(0)
    for (const t of typos) {
      const src = text[t.at]
      expect(src).toBeTruthy()
      expect(src === src.toLowerCase()).toBe(true)
      expect(t.wrong).not.toBe(src)
      expect(t.wrong.length).toBe(1)
      expect(t.backspaces).toBe(1)
    }
  })

  it('概率为 0 时不打错字', () => {
    expect(planTypos('Hello 123!', makeRng(1), 0)).toEqual([])
  })

  it('大写与数字不参与纠错（避免生成不可能的键序）', () => {
    for (const t of planTypos('ABC123xyz', makeRng(9), 1)) {
      expect('xyz'.includes('ABC123xyz'[t.at])).toBe(true)
    }
  })
})

describe('滚动与间隔', () => {
  it('滚动步长累加等于目标距离，且单步不会过大', () => {
    const steps = scrollSteps(1200, makeRng(64))
    expect(steps.length).toBeGreaterThan(2)
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(1200, 0)
    for (const s of steps) expect(Math.abs(s)).toBeLessThanOrEqual(161)
  })

  it('反向滚动保持符号一致', () => {
    const steps = scrollSteps(-500, makeRng(5))
    for (const s of steps) expect(s).toBeLessThan(0)
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(-500, 0)
  })

  it('距离为 0 时不产生步骤', () => {
    expect(scrollSteps(0, makeRng(1))).toEqual([])
  })

  it('actionGap 在配置区间内，关闭时为 0', () => {
    const v = actionGap(std, makeRng(9))
    expect(v).toBeGreaterThanOrEqual(std.actionGapMs[0])
    expect(v).toBeLessThanOrEqual(std.actionGapMs[1])
    expect(actionGap(HUMANIZE_PRESETS.off, makeRng(9))).toBe(0)
  })
})

describe('预设', () => {
  it('预设从弱到强单调递增', () => {
    const order = ['off', 'light', 'standard', 'aggressive'] as const
    const fields: (keyof typeof std)[] = ['actionGapMs', 'mouseDurationMs', 'mouseSteps', 'charDelayMs', 'preClickDwellMs', 'preTypeDwellMs', 'clickHoldMs']
    for (let i = 1; i < order.length; i += 1) {
      const a = presetConfig(order[i - 1])
      const b = presetConfig(order[i])
      for (const f of fields) {
        const ra = a[f] as [number, number]
        const rb = b[f] as [number, number]
        expect(rb[1], `${order[i]}.${f}[1] 应 >= ${order[i - 1]}.${f}[1]`).toBeGreaterThanOrEqual(ra[1])
      }
    }
  })

  it('每个预设字段完整、区间合法', () => {
    for (const p of ['off', 'light', 'standard', 'aggressive'] as const) {
      const c = presetConfig(p)
      expect(c.mouseSteps[0]).toBeLessThanOrEqual(c.mouseSteps[1])
      expect(c.charDelayMs[0]).toBeLessThanOrEqual(c.charDelayMs[1])
      expect(c.preClickDwellMs[0]).toBeLessThanOrEqual(c.preClickDwellMs[1])
    }
    expect(DEFAULT_HUMANIZE.preset).toBe('standard')
  })

  it('未知预设回落到标准档而不是崩溃', () => {
    expect(presetConfig('nope' as never).preset).toBe('standard')
  })

  it('standard 默认开启逐字输入、随机落点与曲线移动', () => {
    expect(DEFAULT_HUMANIZE.typeCharByChar).toBe(true)
    expect(DEFAULT_HUMANIZE.randomClickPoint).toBe(true)
    expect(DEFAULT_HUMANIZE.mouseMove).toBe(true)
    expect(HUMANIZE_PRESETS.off.enabled).toBe(false)
    expect(HUMANIZE_PRESETS.off.mouseMove).toBe(false)
  })
})