import { getDb } from '../index'
import { log } from '../../lib/log'

/**
 * 数据库自身的保留策略（与「登录态保留策略」是两回事）。
 *
 * audit_logs / usage_logs / rpa_runs 只有写入没有清理，长期跑必然无限增长：
 * 每次打开/关闭环境、每次检测、每次设置变更都写一行，一年下来是几十万行，
 * 而操作历史页只展示最近几百条。tls_observations 早就有 pruneObservations，
 * 这三张表却漏了。
 *
 * 策略：按「保留条数」裁剪而不是按时间 —— 条数上限让列表页与磁盘占用都可预期，
 * 而且不会因为用户几个月没打开应用就把全部历史清空。
 */

export interface RetentionLimits {
  /** 审计日志保留条数 */
  auditLogs: number
  /** 使用日志保留条数 */
  usageLogs: number
  /** RPA 运行记录保留条数 */
  rpaRuns: number
}

export const DEFAULT_DB_RETENTION: RetentionLimits = {
  auditLogs: 5000,
  usageLogs: 20000,
  rpaRuns: 500
}

/**
 * 按 id 倒序保留最近 keep 条（两张表都是 AUTOINCREMENT 主键，id 大即时近）。
 * 语句写死而不是拼表名：拼字符串会让「传错表名」变成运行时 SQL 错误，
 * 也让静态检查无法证明没有注入面。
 */
function pruneAudit(keep: number): number {
  if (keep <= 0) return 0
  return getDb()
    .prepare('DELETE FROM audit_logs WHERE id NOT IN (SELECT id FROM audit_logs ORDER BY id DESC LIMIT ?)')
    .run(keep).changes
}

function pruneUsage(keep: number): number {
  if (keep <= 0) return 0
  return getDb()
    .prepare('DELETE FROM usage_logs WHERE id NOT IN (SELECT id FROM usage_logs ORDER BY id DESC LIMIT ?)')
    .run(keep).changes
}

/** rpa_runs 没有 AUTOINCREMENT，按 started_at 裁剪 */
function pruneRpaRuns(keep: number): number {
  if (keep <= 0) return 0
  return getDb()
    .prepare('DELETE FROM rpa_runs WHERE id NOT IN (SELECT id FROM rpa_runs ORDER BY started_at DESC LIMIT ?)')
    .run(keep).changes
}

/**
 * 执行一轮裁剪，返回各表删除的行数。
 * 幂等且廉价（有索引支撑），可由定时器反复调用。
 */
export function pruneDbLogs(limits: Partial<RetentionLimits> = {}): {
  auditLogs: number
  usageLogs: number
  rpaRuns: number
} {
  const lim = { ...DEFAULT_DB_RETENTION, ...limits }
  const out = {
    auditLogs: pruneAudit(lim.auditLogs),
    usageLogs: pruneUsage(lim.usageLogs),
    rpaRuns: pruneRpaRuns(lim.rpaRuns)
  }
  const total = out.auditLogs + out.usageLogs + out.rpaRuns
  if (total > 0) {
    log('retention', `日志裁剪：审计 ${out.auditLogs} / 使用 ${out.usageLogs} / RPA 运行 ${out.rpaRuns} 行`)
  }
  return out
}

/** 各表当前行数（设置页/健康页用来判断是否需要清理） */
export function dbLogCounts(): { auditLogs: number; usageLogs: number; rpaRuns: number } {
  const one = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
  return {
    auditLogs: one('SELECT COUNT(*) AS c FROM audit_logs'),
    usageLogs: one('SELECT COUNT(*) AS c FROM usage_logs'),
    rpaRuns: one('SELECT COUNT(*) AS c FROM rpa_runs')
  }
}
