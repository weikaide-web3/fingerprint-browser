import { typedSetting } from '../settings/defs'
import { checkAll as checkAllProxies, list as listProxies } from './proxies'
import { retentionAlerts } from './session'
import { runDetection } from './detect'
import { getSetting, setSetting, deleteSetting } from '../db/repositories/settings'
import { getProfile } from '../db/repositories/profiles'
import { pruneDbLogs } from '../db/repositories/retention'
import { pruneObservations as pruneTlsObservations } from '../db/repositories/tls'
import { getDb, isDbReady } from '../db'
import { log, logError } from '../lib/log'
import type { MonitorAlerts } from '@shared/ops'

/**
 * 后台监控：代理自动检测、登录态到期提醒、指纹漂移检测。
 *
 * 三个独立定时器，各自按设置的间隔跑。结果缓存在内存里供 UI 读取，
 * 漂移基线分数持久化到 settings（driftBaseline:<profileId> = score）。
 */

let alerts: MonitorAlerts = {
  proxyFailed: [],
  cookieExpiring: [],
  drift: [],
  lastProxyCheckAt: null,
  lastDriftCheckAt: null
}

const timers: NodeJS.Timeout[] = []
const delays: NodeJS.Timeout[] = []

export function getAlerts(): MonitorAlerts {
  return alerts
}

/** 代理自动检测：跑一遍全部代理，把失败的收集进 alerts */
export async function runProxyCheck(): Promise<void> {
  if (!typedSetting<boolean>('monitor.proxyAutoCheck', true)) return
  try {
    const result = await checkAllProxies()
    alerts.proxyFailed = result.failed.map((f) => {
      const p = listProxies().find((x) => x.id === f.id)
      return { id: f.id, name: p?.name ?? f.id, error: f.error }
    })
    alerts.lastProxyCheckAt = Date.now()
    if (result.failed.length) log('monitor', `代理自动检测：${result.failed.length} 个失败`)
  } catch (e) {
    logError('monitor', '代理自动检测失败', e)
  }
}

/** 登录态到期提醒 */
export function runCookieCheck(): void {
  if (!typedSetting<boolean>('monitor.cookieExpiry', true)) return
  try {
    const list = retentionAlerts(7)
    alerts.cookieExpiring = list
      .filter((a) => a.expired || a.soon)
      .map((a) => ({ profileId: a.profileId, name: a.name, daysLeft: a.daysLeft, expired: a.expired }))
  } catch (e) {
    logError('monitor', '登录态到期检查失败', e)
  }
}

/**
 * 漂移判定纯函数：基线分数 vs 最新分数。
 * - drop = baseline - score
 * - 下降达到 threshold 视为告警，且保留旧基线（持续告警直到恢复）
 * - 否则更新基线为最新分数
 */
export function decideDrift(
  baseline: number,
  score: number,
  threshold = 15
): { drop: number; alert: boolean; updateBaseline: boolean } {
  const drop = baseline - score
  return { drop, alert: drop >= threshold, updateBaseline: drop < threshold }
}

/** 指纹漂移检测：重跑检测并与基线分数比对 */
export async function runDriftCheck(): Promise<void> {
  if (!typedSetting<boolean>('monitor.drift', false)) return
  try {
    const found: MonitorAlerts['drift'] = []
    for (const key of Object.keys(getAllDriftBaselines())) {
      const profileId = key.replace('driftBaseline:', '')
      const baseline = getSetting<number>(key, 0)
      // 环境已删除 / 进回收站：基线是孤儿，顺手清掉，不再浪费一次内核启动
      if (!getProfile(profileId)) {
        deleteSetting(key)
        continue
      }
      try {
        const report = await runDetection(profileId, { samples: 1 })
        if (report.error) continue
        const { drop, alert, updateBaseline } = decideDrift(baseline, report.score)
        if (alert) {
          found.push({ profileId, name: report.name, from: baseline, to: report.score, drop })
        }
        // 更新基线为最新分数（除非大幅下降，保留旧基线以便持续告警）
        if (updateBaseline) setSetting(key, report.score)
      } catch {
        /* 单环境失败不影响整体 */
      }
    }
    alerts.drift = found
    alerts.lastDriftCheckAt = Date.now()
    if (found.length) log('monitor', `指纹漂移检测：${found.length} 个环境分数明显下降`)
  } catch (e) {
    logError('monitor', '指纹漂移检测失败', e)
  }
}

/** 记录某环境的漂移基线（detect 跑完后调用） */
export function setDriftBaseline(profileId: string, score: number): void {
  setSetting(`driftBaseline:${profileId}`, score)
}

function getAllDriftBaselines(): Record<string, number> {
  // settings 表里所有 driftBaseline:* —— 这里用一个简单查询
  // 为避免引入新 repo，复用 getSetting 逐个读：基线在 detect 时写入，数量可控
  const out: Record<string, number> = {}
  // 通过 listProxies 拿不到 profile，这里直接读 settings 表
  const rows = getDb()
    .prepare("SELECT key, value, type FROM settings WHERE key LIKE 'driftBaseline:%'")
    .all() as { key: string; value: string | null; type: string }[]
  for (const r of rows) {
    if (r.type === 'number' && r.value !== null) out[r.key] = Number(r.value)
  }
  return out
}

export function startMonitor(): void {
  const proxyMin = typedSetting<number>('monitor.proxyIntervalMin', 30)
  const driftMin = typedSetting<number>('monitor.driftIntervalMin', 720)

  if (typedSetting<boolean>('monitor.proxyAutoCheck', true)) {
    // 启动后延迟 30s 跑第一次，避免和启动争资源
    delays.push(setTimeout(() => void runProxyCheck(), 30_000))
    timers.push(setInterval(() => void runProxyCheck(), proxyMin * 60_000))
  }
  if (typedSetting<boolean>('monitor.cookieExpiry', true)) {
    delays.push(setTimeout(() => runCookieCheck(), 10_000))
    timers.push(setInterval(() => runCookieCheck(), 10 * 60_000))
  }
  if (typedSetting<boolean>('monitor.drift', false)) {
    timers.push(setInterval(() => void runDriftCheck(), driftMin * 60_000))
  }
  // 日志保留：audit_logs / usage_logs / rpa_runs 只有写入没有清理，
  // 长期跑会涨到几十万行而界面只看最近几百条。每天裁一次，开销可忽略。
  timers.push(setInterval(() => void runRetention(), 24 * 60 * 60_000))
  delays.push(setTimeout(() => void runRetention(), 60_000))
  log('monitor', '后台监控已启动')
}

/** 数据库日志裁剪 */
export async function runRetention(): Promise<void> {
  if (!isDbReady()) return
  try {
    pruneDbLogs()
    pruneTlsObservations()
  } catch (e) {
    logError('monitor', '日志裁剪失败', e)
  }
}

export function stopMonitor(): void {
  for (const t of timers) clearInterval(t)
  timers.length = 0
  for (const d of delays) clearTimeout(d)
  delays.length = 0
}
