import { getDb } from '../index'
import { newId, now } from '../../lib/id'
import type { ScheduleRecord } from '@shared/ops'

/**
 * rpa_schedules 仓储：定时任务的增删改查 + 下次执行时间维护。
 */

interface ScheduleRow {
  id: string
  flow_id: string
  cron: string
  enabled: number
  params: string | null
  next_run_at: number | null
  created_at: number
}

function mapRow(row: ScheduleRow): ScheduleRecord {
  let params: Record<string, string> = {}
  let profileId = ''
  try {
    const parsed = JSON.parse(row.params ?? '{}') as { params?: Record<string, string>; profileId?: string }
    params = parsed.params ?? {}
    profileId = parsed.profileId ?? ''
  } catch {
    /* 坏数据按空处理 */
  }
  let flowName = row.flow_id
  try {
    const flow = getDb().prepare('SELECT name FROM rpa_flows WHERE id = ?').get(row.flow_id) as { name?: string } | undefined
    if (flow?.name) flowName = flow.name
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    flowId: row.flow_id,
    flowName,
    cron: row.cron,
    enabled: row.enabled === 1,
    params,
    profileId,
    nextRunAt: row.next_run_at,
    lastRunAt: null,
    createdAt: row.created_at
  }
}

export function listSchedules(): ScheduleRecord[] {
  const rows = getDb().prepare('SELECT * FROM rpa_schedules ORDER BY created_at DESC').all() as ScheduleRow[]
  return rows.map(mapRow)
}

export function getSchedule(id: string): ScheduleRecord | null {
  const row = getDb().prepare('SELECT * FROM rpa_schedules WHERE id = ?').get(id) as ScheduleRow | undefined
  return row ? mapRow(row) : null
}

export function createSchedule(input: {
  flowId: string
  cron: string
  profileId: string
  params?: Record<string, string>
  enabled?: boolean
  nextRunAt?: number | null
}): ScheduleRecord {
  const id = newId('sch')
  const payload = JSON.stringify({ params: input.params ?? {}, profileId: input.profileId })
  getDb()
    .prepare('INSERT INTO rpa_schedules (id, flow_id, cron, enabled, params, next_run_at, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, input.flowId, input.cron, input.enabled === false ? 0 : 1, payload, input.nextRunAt ?? null, now())
  return getSchedule(id)!
}

export function updateSchedule(
  id: string,
  patch: { cron?: string; enabled?: boolean; params?: Record<string, string>; profileId?: string; nextRunAt?: number | null }
): ScheduleRecord | null {
  const cur = getSchedule(id)
  if (!cur) return null
  const fields: string[] = []
  const values: unknown[] = []
  if (patch.cron !== undefined) { fields.push('cron = ?'); values.push(patch.cron) }
  if (patch.enabled !== undefined) { fields.push('enabled = ?'); values.push(patch.enabled ? 1 : 0) }
  if (patch.nextRunAt !== undefined) { fields.push('next_run_at = ?'); values.push(patch.nextRunAt) }
  if (patch.params !== undefined || patch.profileId !== undefined) {
    const payload = JSON.stringify({
      params: patch.params ?? cur.params,
      profileId: patch.profileId ?? cur.profileId
    })
    fields.push('params = ?')
    values.push(payload)
  }
  if (fields.length) {
    values.push(id)
    getDb().prepare(`UPDATE rpa_schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  return getSchedule(id)
}

export function deleteSchedule(id: string): boolean {
  return getDb().prepare('DELETE FROM rpa_schedules WHERE id = ?').run(id).changes > 0
}

export function setNextRun(id: string, nextRunAt: number | null): void {
  getDb().prepare('UPDATE rpa_schedules SET next_run_at = ? WHERE id = ?').run(nextRunAt, id)
}
