import fs from 'node:fs'
import path from 'node:path'
import { withContext } from '../browser/with-context'
import { awaitPageInjection } from '../fingerprint/injector'
import { getProfile } from '../db/repositories/profiles'
import {
  createFlow,
  deleteFlow,
  finishRun,
  getFlow,
  getRunLog,
  listFlows,
  listRuns,
  startRun,
  updateFlow
} from '../db/repositories/rpa'
import { executeFlow } from '../rpa/runner'
import { precheckConditions, validateFlow } from '../rpa/validate'
import { gateForRun } from './association'
import { typedSetting } from '../settings/defs'
import { DEFAULT_HUMANIZE, presetConfig, type HumanizeConfig, type HumanizePreset } from '@shared/humanize'
import { newId } from '../lib/id'
import { log, logError } from '../lib/log'
import { dataDir, ensureDir } from '../paths'
import type { FlowRecord, RunResult, RunSummary, RpaFlow, StepLogEntry } from '@shared/rpa'

/**
 * RPA 服务：流程增删改查 + 在指定环境的真实内核里执行。
 *
 * 执行时复用环境已有的内核；没开则以**有头**模式临时拉起（绝不 headless），
 * 所以流程跑在「那个环境该有的指纹 + 代理 + 登录态」里 —— 这正是指纹浏览器
 * 做自动化的意义：换环境就是换身份，而不是换一台机器。
 */

export interface RunOptions {
  flowId: string
  profileId: string
  params?: Record<string, string>
  /** 执行时把步骤日志推给界面 */
  onEvent?: (e: StepLogEntry) => void
  /** 拿到本次 runId 后立即回调：调用方要用它给日志事件打标签 */
  onStart?: (runId: string) => void
  shouldStop?: () => boolean
  /**
   * 用 headless 跑。默认 false，且传 true 也会被忽略：
   * RPA 会真实操作站点，headless 的设备特征与有头不同，等于换了个身份。
   */
  headless?: boolean
  /** 本次运行的人类化覆盖（优先级高于流程级与全局预设） */
  humanize?: Partial<HumanizeConfig>
  /** 固定随机种子：同一 seed 得到同一套鼠标轨迹与打字节奏，便于复现问题 */
  seed?: string
  /** 跳过关联风险闸门（仅本次运行） */
  skipAssociationGate?: boolean
}

export interface RunOutcome {
  run: RunResult
  validation: ReturnType<typeof validateFlow>
}

/** 正在跑的流程：用来按 runId 停止 */
const activeRuns = new Map<string, { stop: () => void; profileId: string; flowName: string }>()

export function activeRunCount(): number {
  return activeRuns.size
}

export function activeRunsView(): { runId: string; profileId: string; flowName: string }[] {
  return [...activeRuns.entries()].map(([runId, v]) => ({ runId, profileId: v.profileId, flowName: v.flowName }))
}

export function requestStop(runId: string): boolean {
  const active = activeRuns.get(runId)
  if (!active) return false
  active.stop()
  return true
}

/** 停止某个环境上所有在跑的流程（环境被关闭时调用） */
export function requestStopForProfile(profileId: string): number {
  let n = 0
  for (const v of activeRuns.values()) {
    if (v.profileId === profileId) {
      v.stop()
      n += 1
    }
  }
  return n
}

function runsRoot(): string {
  return ensureDir(path.join(dataDir(), 'rpa-runs'))
}

export function flows(): FlowRecord[] {
  return listFlows()
}

export function flow(id: string): RpaFlow | null {
  return getFlow(id)
}

export function create(input: RpaFlow): FlowRecord {
  const v = validateFlow(input)
  if (!v.ok) {
    const first = v.issues.find((i) => i.level === 'error')
    throw new Error(`流程有问题（${v.errors} 处）：${first?.message ?? ''} ${first?.path ?? ''}`.trim())
  }
  return createFlow(input)
}

export function update(id: string, input: RpaFlow): FlowRecord | null {
  const v = validateFlow(input)
  if (!v.ok) {
    const first = v.issues.find((i) => i.level === 'error')
    throw new Error(`流程有问题（${v.errors} 处）：${first?.message ?? ''} ${first?.path ?? ''}`.trim())
  }
  return updateFlow(id, input)
}

export function remove(id: string): void {
  deleteFlow(id)
}

export function validate(input: RpaFlow): ReturnType<typeof validateFlow> {
  return validateFlow(input)
}

export function runs(limit = 50): RunSummary[] {
  return listRuns(limit)
}

export function runLog(runId: string): { summary: RunSummary | null; log: unknown[]; files: string[] } | null {
  return getRunLog(runId)
}

/**
 * 解析本次运行的人类化配置：全局预设 → 流程级覆盖 → 运行参数覆盖。
 * 流程级覆盖允许单个流程关掉人类化（本地自测）或加强（高风险站点）。
 */
function resolveHumanize(flow: RpaFlow, override?: Partial<HumanizeConfig>): HumanizeConfig {
  const preset = typedSetting<HumanizePreset>('rpaHumanizePreset', 'standard')
  return { ...DEFAULT_HUMANIZE, ...presetConfig(preset), ...(flow.humanize ?? {}), ...(override ?? {}) }
}

export async function run(opts: RunOptions): Promise<RunOutcome> {
  const stored = getFlow(opts.flowId)
  if (!stored) throw new Error(`流程不存在：${opts.flowId}`)
  const profile = getProfile(opts.profileId)
  if (!profile) throw new Error(`环境不存在：${opts.profileId}`)

  const validation = validateFlow(stored)
  // RpaFlow.id 是可选的（新建时还没 id），从库里读出来一定有；这里兜一层让类型闭合
  const flowId = stored.id ?? opts.flowId
  if (!validation.ok) {
    throw new Error(`流程有 ${validation.errors} 处错误，先修好再跑：${validation.issues[0]?.message ?? ''}`)
  }

  // 关联闸门：流程本身没问题不代表可以安全地跑在这个环境上。
  // 共用出口 / 同账号多环境 / 机房 IP 这类问题一旦触发就是整批账号连坐，
  // 所以默认在启动内核之前就拦住，而不是等流程跑完一半才发现。
  const blocking = gateForRun(profile.id, { skip: opts.skipAssociationGate })
  if (blocking?.length) {
    throw new Error(
      `关联风险检查未通过（${blocking.length} 项严重）：${blocking[0].message}${blocking.length > 1 ? `；另有 ${blocking.length - 1} 项` : ''}`
    )
  }

  const params = { ...(stored.params ?? {}), ...(opts.params ?? {}) }
  const badCondition = precheckConditions(stored, params).find((i) => i.level === 'error')
  if (badCondition) throw new Error(`条件写错了：${badCondition.path} → ${badCondition.message}`)

  const runId = newId('run')
  const outDir = ensureDir(path.join(runsRoot(), runId))
  startRun(runId, flowId, profile.id, stored.name)
  opts.onStart?.(runId)

  let stopRequested = false
  const stop = (): void => {
    stopRequested = true
  }
  activeRuns.set(runId, { stop, profileId: profile.id, flowName: stored.name })

  const startedAt = Date.now()
  let outcome: Awaited<ReturnType<typeof executeFlow>>
  try {
    outcome = await withContext(
      profile.id,
      '执行 RPA 流程',
      async (ctx) => {
        const page = await ctx.newPage()
        try {
          // 等 CDP 覆盖落地再跑流程，否则首个文档请求的 UA/CH/时区是内核默认值
          await awaitPageInjection(page)
          return await executeFlow({
            flow: stored,
            page,
            outDir,
            params,
            onEvent: opts.onEvent,
            shouldStop: () => stopRequested || opts.shouldStop?.() === true,
            humanize: resolveHumanize(stored, opts.humanize),
            seed: opts.seed
          })
        } finally {
          await page.close().catch(() => undefined)
        }
      },
      // RPA 会真实点击 / 输入 / 登录，属于「访问真实站点」：
      // 绝不允许为了省事用 headless 跑，那等于把另一个设备特征送去给目标站点。
      { realSite: true, headless: opts.headless === true ? false : undefined }
    )
  } catch (e) {
    activeRuns.delete(runId)
    // 内核起不来 / 中途崩掉：也要留下一条失败记录，否则用户看不到任何痕迹
    const message = e instanceof Error ? e.message : String(e)
    logError('rpa', `运行 ${stored.name} 失败`, e)
    const run: RunResult = {
      id: runId,
      flowId,
      flowName: stored.name,
      profileId: profile.id,
      status: 'failed',
      startedAt,
      finishedAt: Date.now(),
      stats: { ok: 0, failed: 1, skipped: 0, retried: 0, durationMs: Date.now() - startedAt },
      log: [],
      files: [],
      error: message
    }
    finishRun(run, null)
    return { run, validation }
  }
  activeRuns.delete(runId)

  const logPath = path.join(outDir, 'steps.json')
  try {
    fs.writeFileSync(logPath, JSON.stringify(outcome.log, null, 2), 'utf8')
  } catch (e) {
    logError('rpa', '写步骤日志失败', e)
  }

  const run: RunResult = {
    id: runId,
    flowId,
    flowName: stored.name,
    profileId: profile.id,
    status: outcome.status,
    startedAt,
    finishedAt: Date.now(),
    stats: outcome.stats,
    log: outcome.log,
    files: fs.existsSync(logPath) ? [logPath, ...outcome.files] : outcome.files,
    error: outcome.error
  }
  finishRun(run, fs.existsSync(logPath) ? logPath : null)
  log('rpa', `${stored.name} @ ${profile.name} => ${run.status}（ok=${run.stats.ok} failed=${run.stats.failed} ${run.stats.durationMs}ms）`)
  return { run, validation }
}

/** 内置示例流程：见 rpa/sample.ts（纯模块，便于单测与界面共用） */
export { sampleFlow } from '../rpa/sample'