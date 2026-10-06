import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  setNextRun,
  updateSchedule
} from '../db/repositories/schedules'
import { isValidCron, nextRun } from '@shared/cron'
import { getFlow } from '../db/repositories/rpa'
import { getProfile } from '../db/repositories/profiles'
import { run as runFlow } from './rpa'
import { log, logError } from '../lib/log'
import type { ScheduleRecord } from '@shared/ops'

/**
 * RPA 定时调度器。
 *
 * 用 setInterval 每分钟检查一次到期的 schedule，到点就触发对应流程在指定环境里跑。
 * 不引入第三方 cron 库：自研解析（shared/cron.ts）+ 一个轮询 tick 足够，
 * 而且能在单测里直接调用 tick() 验证触发逻辑。
 */

let timer: NodeJS.Timeout | null = null
let ticking = false
const runningNow = new Set<string>()

export interface ScheduleInput {
  flowId: string
  cron: string
  profileId: string
  params?: Record<string, string>
  enabled?: boolean
}

export function list(): ScheduleRecord[] {
  return listSchedules()
}

export function create(input: ScheduleInput): ScheduleRecord {
  if (!isValidCron(input.cron)) throw new Error(`无效的 cron 表达式：${input.cron}`)
  if (!getFlow(input.flowId)) throw new Error(`流程不存在：${input.flowId}`)
  if (!getProfile(input.profileId)) throw new Error(`环境不存在：${input.profileId}`)
  const next = nextRun(input.cron)
  return createSchedule({ ...input, nextRunAt: next })
}

export function update(
  id: string,
  patch: { cron?: string; enabled?: boolean; params?: Record<string, string>; profileId?: string }
): ScheduleRecord | null {
  if (patch.cron !== undefined && !isValidCron(patch.cron)) throw new Error(`无效的 cron 表达式：${patch.cron}`)
  const cur = getSchedule(id)
  if (!cur) return null
  const merged = { ...cur, ...patch }
  const next = merged.enabled ? nextRun(merged.cron) : null
  return updateSchedule(id, { ...patch, nextRunAt: next })
}

export function remove(id: string): boolean {
  return deleteSchedule(id)
}

export function toggle(id: string, enabled: boolean): ScheduleRecord | null {
  const cur = getSchedule(id)
  if (!cur) return null
  const next = enabled ? nextRun(cur.cron) : null
  return updateSchedule(id, { enabled, nextRunAt: next })
}

/** 立即触发一次（不影响下次计划时间） */
export async function runNow(id: string): Promise<void> {
  const s = getSchedule(id)
  if (!s) throw new Error(`定时任务不存在：${id}`)
  await fireSchedule(s)
}

async function fireSchedule(s: ScheduleRecord): Promise<void> {
  if (runningNow.has(s.id)) return
  runningNow.add(s.id)
  try {
    log('scheduler', `触发定时任务 ${s.id}（流程「${s.flowName}」@ 环境 ${s.profileId}）`)
    await runFlow({ flowId: s.flowId, profileId: s.profileId, params: s.params })
  } catch (e) {
    logError('scheduler', `定时任务 ${s.id} 执行失败`, e)
  } finally {
    runningNow.delete(s.id)
  }
}

/**
 * 一次 tick 的纯决策：给定一组 schedule 和当前时间，返回
 * - fire：本次应触发并已推进下次时间的任务（id + 新的 nextRunAt）
 * - backfill：启用了但没有 nextRunAt（刚启用）的任务，需要补算
 * 不碰数据库、不执行流程，便于单测。
 */
export function planTick(
  schedules: { id: string; enabled: boolean; cron: string; nextRunAt: number | null }[],
  at: number
): { fire: { id: string; nextRunAt: number | null }[]; backfill: { id: string; nextRunAt: number | null }[] } {
  const fire: { id: string; nextRunAt: number | null }[] = []
  const backfill: { id: string; nextRunAt: number | null }[] = []
  for (const s of schedules) {
    if (!s.enabled) continue
    if (s.nextRunAt === null) {
      backfill.push({ id: s.id, nextRunAt: nextRun(s.cron, at) })
      continue
    }
    if (s.nextRunAt <= at) {
      // 先推进下次时间，避免执行耗时长导致重复触发
      fire.push({ id: s.id, nextRunAt: nextRun(s.cron, at) })
    }
  }
  return { fire, backfill }
}

/**
 * 一次 tick：检查所有到期任务并触发。返回本次触发的数量。
 * 导出以便单测直接调用。
 */
export async function tick(at = Date.now()): Promise<number> {
  if (ticking) return 0
  ticking = true
  let fired = 0
  try {
    const { fire, backfill } = planTick(listSchedules(), at)
    for (const b of backfill) setNextRun(b.id, b.nextRunAt)
    for (const f of fire) {
      fired += 1
      setNextRun(f.id, f.nextRunAt)
      const s = getSchedule(f.id)
      if (s) void fireSchedule(s)
    }
  } finally {
    ticking = false
  }
  return fired
}

export function startScheduler(): void {
  if (timer) return
  // 启动时把所有启用的任务的 nextRunAt 重算一遍（停机期间可能已过期）
  for (const s of listSchedules()) {
    if (s.enabled) setNextRun(s.id, nextRun(s.cron))
  }
  timer = setInterval(() => {
    void tick()
  }, 60_000)
  log('scheduler', '定时调度器已启动（每 60s 检查一次）')
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // 清空在途标记，避免退出后状态残留
  runningNow.clear()
}
