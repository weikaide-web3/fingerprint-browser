import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright-core'
import { evalCondition, interpolate, type Value } from './expr'
import { describeStep } from './validate'
import {
  actionGap,
  clickPoint,
  hashSeed,
  jitter,
  makeRng,
  mousePath,
  planTypos,
  typingDelays,
  type Point,
  type Rng
} from './humanize'
import { DEFAULT_HUMANIZE, type HumanizeConfig } from '@shared/humanize'
import { log, logError } from '../lib/log'
import type { RunStats, RpaFlow, RpaStep, StepLogEntry, StepStatus, StepType } from '@shared/rpa'

/**
 * 流程执行器：在真实内核的 Page 上按步骤顺序跑。
 *
 * 几个刻意的选择：
 * - 每步都写日志（含耗时），失败时能看到卡在哪一步、等了多久；
 * - 失败默认停止，但单步可配 retry / continue，登录页偶发抖动不必整个流程重来；
 * - 条件与循环用自研求值器，绝不 eval 用户条件串。
 */

export interface ExecuteOptions {
  flow: RpaFlow
  page: Page
  /** 截图等产物落在这里 */
  outDir: string
  params?: Record<string, string>
  onEvent?: (e: StepLogEntry) => void
  shouldStop?: () => boolean
  /** 人类化行为配置；默认 standard */
  humanize?: HumanizeConfig
  /** 随机种子；留空则按 flow + 时间生成（每次不同） */
  seed?: string
}

export interface ExecuteOutcome {
  status: 'success' | 'failed' | 'stopped'
  stats: RunStats
  log: StepLogEntry[]
  files: string[]
  error: string | null
  vars: Record<string, Value>
}

interface Ctx {
  page: Page
  vars: Record<string, Value>
  timeout: number
  outDir: string
  files: string[]
  hz: HumanizeConfig
  rng: Rng
  /** 上一次鼠标位置：轨迹必须从它出发，不能每次都从 (0,0) 瞬移 */
  mouse: Point
}

const DEFAULT_TIMEOUT = 15000
/** 死循环兜底：一次运行最多执行多少步（循环展开后计数） */
const MAX_STEPS_PER_RUN = 5000

export class StepFailed extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function expandIn(raw: unknown, vars: Record<string, Value>): { text: string; missing: string[] } {
  return interpolate(String(raw ?? ''), vars)
}

/**
 * 把鼠标沿贝塞尔曲线移到目标点，并补发 mousemove。
 * Playwright 的 click 默认是「瞬移到元素正中」，没有任何 mousemove —— 这是最典型的机器人特征。
 */
async function moveMouseTo(ctx: Ctx, to: Point): Promise<void> {
  if (!ctx.hz.enabled || !ctx.hz.mouseMove) {
    // 即使关闭曲线移动，也必须把鼠标真正挪到目标点：
    // 只更新内部状态的话，随后的 down/up 会打在 (0,0)，点击落到完全无关的元素上。
    await ctx.page.mouse.move(to.x, to.y, { steps: 1 })
    ctx.mouse = to
    return
  }
  const path = mousePath(ctx.mouse, to, ctx.hz, ctx.rng)
  let prevT = 0
  for (const p of path) {
    await ctx.page.mouse.move(p.x, p.y, { steps: 1 })
    const delta = p.t - prevT
    prevT = p.t
    if (delta > 0) await sleep(delta)
  }
  ctx.mouse = to
}

/** 元素内可见矩形（滚动到视口内之后取） */
async function visibleBox(page: Page, selector: string, timeout: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const loc = page.locator(selector).first()
  await loc.waitFor({ state: 'visible', timeout })
  await loc.scrollIntoViewIfNeeded({ timeout })
  const box = await loc.boundingBox({ timeout })
  if (!box || box.width <= 0 || box.height <= 0) throw new StepFailed(`元素不可点击（尺寸为 0）：${selector}`)
  return box
}

/**
 * 人类化点击：滚动到可见 → 鼠标沿曲线移动 → 悬停犹豫 → 随机落点 → down/up 带间隔。
 * 落点用 CDP 级别的 mouse.down/up，而不是 locator.click()，
 * 因为后者内部会重新计算「元素正中」并跳过我们选的点。
 */
async function humanClick(ctx: Ctx, selector: string, timeout: number, rightClick = false): Promise<string> {
  const box = await visibleBox(ctx.page, selector, timeout)
  const target = ctx.hz.enabled && ctx.hz.randomClickPoint ? clickPoint(box, ctx.rng) : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await moveMouseTo(ctx, target)
  if (ctx.hz.enabled) {
    // 到位后再犹豫一下：人眼定位需要时间，且这段停顿里通常会有微小的鼠标抖动
    await sleep(jitter(ctx.rng, ctx.hz.preClickDwellMs))
    if (ctx.rng() < 0.35) await ctx.page.mouse.move(target.x + (ctx.rng() * 2 - 1) * 1.5, target.y + (ctx.rng() * 2 - 1) * 1.5, { steps: 1 })
  }
  await ctx.page.mouse.down({ button: rightClick ? 'right' : 'left' })
  await sleep(ctx.hz.enabled ? jitter(ctx.rng, ctx.hz.clickHoldMs) : 0)
  await ctx.page.mouse.up({ button: rightClick ? 'right' : 'left' })
  return `(${target.x.toFixed(1)}, ${target.y.toFixed(1)})`
}

/**
 * 人类化输入：逐字符敲，带节奏；可选模拟「打错再删」。
 * 用 fill() 一次性塞值会让 input 事件在 0ms 内全部完成，事件时间戳序列一眼假。
 */
async function humanType(ctx: Ctx, selector: string, value: string, timeout: number): Promise<void> {
  const loc = ctx.page.locator(selector).first()
  await loc.waitFor({ state: 'visible', timeout })
  await loc.scrollIntoViewIfNeeded({ timeout })
  if (!ctx.hz.enabled || !ctx.hz.typeCharByChar) {
    await loc.fill(value, { timeout })
    return
  }
  const box = await loc.boundingBox({ timeout })
  if (box) await moveMouseTo(ctx, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  await sleep(jitter(ctx.rng, ctx.hz.preTypeDwellMs))
  // 聚焦也必须走人类化点击：locator.click() 内部会把鼠标瞬移到元素正中，
  // 等于在我们精心构造的轨迹之后又补了一次机器人式跳转。
  await humanClick(ctx, selector, timeout)
  // 清空已有内容：用键盘而不是直接改 value，事件序列才与真人一致
  await ctx.page.keyboard.press('Control+a')
  await sleep(jitter(ctx.rng, [30, 120]))
  await ctx.page.keyboard.press('Delete')

  const delays = typingDelays(value, ctx.hz, ctx.rng)
  const typos = ctx.hz.typoSimulation ? planTypos(value, ctx.rng) : []
  const typoAt = new Map(typos.map((t) => [t.at, t]))
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    await ctx.page.keyboard.type(ch)
    const typo = typoAt.get(i)
    if (typo) {
      // 打错 → 停一下（意识到错了）→ 回删 → 继续敲正确的字符
      await ctx.page.keyboard.type(typo.wrong)
      await sleep(jitter(ctx.rng, [180, 620]))
      for (let b = 0; b < typo.backspaces; b += 1) await ctx.page.keyboard.press('Backspace')
      await sleep(jitter(ctx.rng, [60, 220]))
    }
    await sleep(delays[i])
  }
}

/** 导航与交互类步骤 */
async function actSimple(step: RpaStep, ctx: Ctx): Promise<{ message: string; value?: string }> {
  const s = step as unknown as Record<string, unknown>
  const { page, timeout } = ctx
  const sel = (): string => expandIn(s.selector, ctx.vars).text
  switch (step.type) {
    case 'goto': {
      const url = expandIn(s.url, ctx.vars).text
      await page.goto(url, {
        waitUntil: (s.waitUntil as 'load' | 'domcontentloaded' | 'networkidle') ?? 'domcontentloaded',
        timeout
      })
      return { message: `已打开 ${url}`, value: page.url() }
    }
    case 'click': {
      const target = sel()
      const at = await humanClick(ctx, target, timeout)
      return { message: `已点击 ${target} @${at}` }
    }
    case 'fill': {
      const target = sel()
      const value = expandIn(s.value, ctx.vars).text
      await humanType(ctx, target, value, timeout)
      if (s.submit) {
        await sleep(jitter(ctx.rng, [60, 240]))
        await ctx.page.keyboard.press('Enter')
      }
      return { message: `已填写 ${target}`, value }
    }
    case 'press': {
      const key = expandIn(s.key, ctx.vars).text
      if (s.selector) {
        const target = sel()
        await ctx.page.locator(target).first().press(key, { timeout })
        return { message: `已在 ${target} 按下 ${key}` }
      }
      await ctx.page.keyboard.press(key)
      return { message: `已按下 ${key}` }
    }
    case 'select': {
      const target = sel()
      const value = expandIn(s.value, ctx.vars).text
      await page.selectOption(target, value, { timeout })
      return { message: `已选择 ${target} = ${value}` }
    }
    case 'hover': {
      const target = sel()
      const box = await visibleBox(page, target, timeout)
      await moveMouseTo(ctx, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
      return { message: `已悬停 ${target}` }
    }
    case 'wait': {
      if (!s.selector) {
        await page.waitForLoadState('domcontentloaded', { timeout })
        return { message: '页面已加载' }
      }
      const target = sel()
      await page
        .locator(target)
        .first()
        .waitFor({ state: (s.state as 'attached' | 'visible' | 'hidden' | 'detached') ?? 'visible', timeout })
      return { message: `${target} 已${String(s.state ?? 'visible')}` }
    }
    case 'sleep': {
      const ms = Number(s.ms) || 0
      await sleep(ms)
      return { message: `等待 ${ms}ms` }
    }
    default:
      throw new StepFailed(`不是交互类步骤：${step.type}`)
  }
}

/** 取值、断言、变量与产物类步骤 */
async function actData(step: RpaStep, ctx: Ctx): Promise<{ message: string; value?: string }> {
  const s = step as unknown as Record<string, unknown>
  const { page, vars, timeout, outDir } = ctx
  const sel = (): string => expandIn(s.selector, vars).text
  switch (step.type) {
    case 'text': {
      const target = sel()
      const name = String(s.variable)
      let text = ''
      try {
        text = (await page.locator(target).first().textContent({ timeout })) ?? ''
      } catch (e) {
        if (!s.optional) throw e
        vars[name] = ''
        return { message: `${target} 不存在，按 optional 置空`, value: '' }
      }
      text = text.trim()
      vars[name] = text
      return { message: `已抓取 $${name}`, value: text }
    }
    case 'attribute': {
      const target = sel()
      const attr = String(s.attribute)
      const name = String(s.variable)
      let v: string | null = null
      try {
        v = await page.locator(target).first().getAttribute(attr, { timeout })
      } catch (e) {
        if (!s.optional) throw e
      }
      vars[name] = v ?? ''
      return { message: `已抓取 $${name}`, value: v ?? '' }
    }
    case 'assertText': {
      const expected = expandIn(s.expected, vars).text
      const mode = (s.mode as 'contains' | 'equals' | 'regex') ?? 'contains'
      const actual = String(
        s.selector
          ? (await page.locator(sel()).first().textContent({ timeout })) ?? ''
          : await page.evaluate('document.body ? document.body.innerText : ""')
      ).trim()
      let pass = false
      if (mode === 'contains') pass = actual.includes(expected)
      else if (mode === 'equals') pass = actual === expected
      else {
        try {
          pass = new RegExp(expected).test(actual)
        } catch (e) {
          throw new StepFailed(`正则无效：${errText(e)}`)
        }
      }
      if (!pass) throw new StepFailed(`文本断言失败（${mode}）：期望 "${expected}"，实际 "${actual.slice(0, 200)}"`)
      return { message: '文本断言通过', value: actual.slice(0, 200) }
    }
    case 'assertVisible': {
      const target = sel()
      await page.locator(target).first().waitFor({ state: 'visible', timeout })
      return { message: `${target} 可见` }
    }
    case 'evaluate': {
      // 在页面上下文里求值：能读 DOM，但拿不到主进程能力（没有 require / process）
      const result = await page.evaluate(String(s.expression))
      const text = typeof result === 'object' && result !== null ? JSON.stringify(result) : String(result ?? '')
      if (s.variable) vars[String(s.variable)] = text
      return { message: '表达式返回', value: text.slice(0, 300) }
    }
    case 'screenshot': {
      const raw = expandIn(s.filename ?? 'step.png', vars).text || 'step.png'
      const safe = path.basename(raw).replace(/[^\w.-]/g, '_')
      const file = path.join(outDir, safe)
      if (s.selector) await page.locator(sel()).first().screenshot({ path: file, timeout })
      else await page.screenshot({ path: file, fullPage: true })
      ctx.files.push(file)
      return { message: '截图已保存', value: file }
    }
    case 'setVariable': {
      const name = String(s.name)
      const value = expandIn(s.value, vars).text
      vars[name] = value
      return { message: `$${name} = ${value}` }
    }
    case 'log': {
      const msg = expandIn(s.message, vars).text
      log('rpa', msg)
      return { message: msg }
    }
    default:
      throw new StepFailed(`不是取值类步骤：${step.type}`)
  }
}

const SIMPLE_TYPES = new Set(['goto', 'click', 'fill', 'press', 'select', 'hover', 'wait', 'sleep'])

export async function executeFlow(opts: ExecuteOptions): Promise<ExecuteOutcome> {
  const { flow, page, outDir } = opts
  const entries: StepLogEntry[] = []
  const files: string[] = []
  // 流程级参数先落地，调用方传入的同名参数覆盖它：
  // 否则 flow.params 里声明的 ${username} 这类占位符会静默展开成空串。
  const vars: Record<string, Value> = { ...(flow.params ?? {}), ...(opts.params ?? {}) }
  const defaultTimeout = flow.defaultTimeoutMs && flow.defaultTimeoutMs > 0 ? flow.defaultTimeoutMs : DEFAULT_TIMEOUT
  const stats: RunStats = { ok: 0, failed: 0, skipped: 0, retried: 0, durationMs: 0 }
  const startedAt = Date.now()
  const hz = opts.humanize ?? DEFAULT_HUMANIZE
  // 种子决定整条轨迹序列：留空则每次运行都不同（真实场景要不同），
  // 传固定 seed 则可复现，便于测试与「回放同一套动作」。
  const rng = makeRng(hashSeed(opts.seed ?? `${flow.id ?? flow.name}:${startedAt}`))
  const ctx: Ctx = { page, vars, timeout: defaultTimeout, outDir, files, hz, rng, mouse: { x: 20, y: 20 } }
  let executed = 0
  let stopped = false
  let fatal: string | null = null
  // 当前步骤在流程树里的层级，日志界面靠它缩进
  let depth = 0

  fs.mkdirSync(outDir, { recursive: true })

  const emit = (step: RpaStep, status: StepStatus, message: string, durationMs: number, value?: string): void => {
    const entry: StepLogEntry = {
      ts: Date.now(),
      stepId: step.id,
      type: step.type as StepType,
      label: describeStep(step),
      status,
      message,
      durationMs,
      depth,
      ...(value !== undefined ? { value } : {})
    }
    entries.push(entry)
    try {
      opts.onEvent?.(entry)
    } catch (e) {
      logError('rpa', '事件回调异常', e)
    }
  }

  /** 单步执行（含重试）；返回 false 表示应当中止整个流程 */
  async function runOne(step: RpaStep): Promise<boolean> {
    if (executed >= MAX_STEPS_PER_RUN) {
      fatal = `已执行超过 ${MAX_STEPS_PER_RUN} 步，疑似死循环，已停止`
      emit(step, 'failed', fatal, 0)
      stats.failed += 1
      return false
    }
    executed += 1

    if (step.enabled === false) {
      stats.skipped += 1
      emit(step, 'skipped', '该步骤已被禁用', 0)
      return true
    }
    if (step.type === 'if') {
      const s = step as unknown as { condition: string; then: RpaStep[]; else?: RpaStep[] }
      const r = evalConditionSafe(s.condition, vars)
      if (r.error) {
        stats.failed += 1
        emit(step, 'failed', `条件无法求值：${r.error}`, 0)
        return false
      }
      stats.ok += 1
      emit(step, 'ok', `条件 ${s.condition} => ${r.value ? 'true（走 then）' : 'false（走 else）'}`, 0)
      // 分支里的步骤比 if 深一层，日志界面按这个缩进
      depth += 1
      const branchOk = await runAll(r.value ? s.then ?? [] : s.else ?? [])
      depth -= 1
      return branchOk
    }
    if (step.type === 'loop') {
      const s = step as unknown as { times: number; untilCondition?: string; intervalMs?: number; steps: RpaStep[] }
      const times = Number(s.times) || 0
      for (let i = 0; i < times; i += 1) {
        if (opts.shouldStop?.()) {
          stopped = true
          return false
        }
        if (s.untilCondition) {
          const r = evalConditionSafe(s.untilCondition, vars)
          if (r.error) {
            stats.failed += 1
            emit(step, 'failed', `退出条件无法求值：${r.error}`, 0)
            return false
          }
          if (r.value) {
            emit(step, 'ok', `第 ${i + 1} 轮前退出条件成立，结束循环`, 0)
            break
          }
        }
        emit(step, 'ok', `第 ${i + 1}/${times} 轮`, 0)
        stats.ok += 1
        depth += 1
        const iterOk = await runAll(s.steps ?? [])
        depth -= 1
        if (!iterOk) return false
        if (i < times - 1 && s.intervalMs) await sleep(Number(s.intervalMs))
      }
      return true
    }

    const policy = step.onError ?? 'stop'
    const attempts = policy === 'retry' ? Math.max(1, (step.retryCount ?? 2) + 1) : 1
    // 单步超时优先于流程默认值：重试型步骤通常故意把单次超时设得很短
    ctx.timeout = step.timeoutMs && step.timeoutMs > 0 ? step.timeoutMs : defaultTimeout
    const started = Date.now()
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const out = SIMPLE_TYPES.has(step.type) ? await actSimple(step, ctx) : await actData(step, ctx)
        const missing = collectMissing(step, vars)
        stats.ok += 1
        emit(step, 'ok', out.message + (missing ? `（未定义变量：${missing}）` : ''), Date.now() - started, out.value)
        return true
      } catch (e) {
        const msg = errText(e)
        if (attempt < attempts) {
          stats.retried += 1
          emit(step, 'retrying', `第 ${attempt} 次失败：${msg}，${step.retryDelayMs ?? 500}ms 后重试`, Date.now() - started)
          await sleep(step.retryDelayMs ?? 500)
          continue
        }
        stats.failed += 1
        emit(step, 'failed', msg, Date.now() - started)
        if (policy === 'continue') return true
        fatal = `${describeStep(step)} 失败：${msg}`
        return false
      }
    }
    return true
  }

  async function runAll(steps: RpaStep[]): Promise<boolean> {
    for (const step of steps) {
      if (opts.shouldStop?.()) {
        stopped = true
        return false
      }
      // 动作之间插入随机停顿：固定间隔（或零间隔）本身就是特征
      const gap = actionGap(hz, rng)
      if (gap > 0) await sleep(gap)
      if (!(await runOne(step))) return false
    }
    return true
  }

  await runAll(flow.steps ?? [])

  stats.durationMs = Date.now() - startedAt
  const status = stopped ? 'stopped' : fatal ? 'failed' : 'success'
  return { status, stats, log: entries, files, error: fatal, vars }
}

function evalConditionSafe(src: string, vars: Record<string, Value>): { value: boolean; error: string | null } {
  // 条件里引用的变量是运行时才产生的，所以求值要带上当前变量表
  return evalCondition(src, vars)
}

/** 找出步骤里引用了但当前不存在的变量名，用于日志提示 */
function collectMissing(step: RpaStep, vars: Record<string, Value>): string {
  const s = step as unknown as Record<string, unknown>
  const missing = new Set<string>()
  for (const field of ['url', 'value', 'expected', 'message', 'selector', 'key']) {
    const raw = s[field]
    if (typeof raw === 'string') {
      const r = interpolate(raw, vars)
      for (const m of r.missing) missing.add(m)
    }
  }
  return [...missing].join(', ')
}