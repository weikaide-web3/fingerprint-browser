import fs from 'node:fs'
import { getDb } from '../index'
import { newId, now } from '../../lib/id'
import type { FlowRecord, RpaFlow, RunResult, RunStats, RunSummary } from '@shared/rpa'

/**
 * rpa_flows / rpa_runs 仓储。
 *
 * 表结构里 rpa_runs 没有 profile_id 列，所以把 profileId / flowName / error
 * 一起放进 stats JSON —— 不改表也能记录「这次跑在哪个环境上」。
 */

interface FlowRow {
  id: string
  name: string
  description: string | null
  graph: string
  created_at: number
  updated_at: number
}

interface RunRow {
  id: string
  flow_id: string | null
  status: string
  started_at: number
  finished_at: number | null
  log_path: string | null
  stats: string | null
}

type StatsBlob = Partial<RunStats> & { profileId?: string; flowName?: string; error?: string | null; files?: string[] }

function countSteps(flow: RpaFlow): number {
  let n = 0
  const walk = (steps: RpaFlow['steps']): void => {
    for (const s of steps) {
      n += 1
      const any = s as unknown as Record<string, unknown>
      if (Array.isArray(any.then)) walk(any.then as RpaFlow['steps'])
      if (Array.isArray(any.else)) walk(any.else as RpaFlow['steps'])
      if (Array.isArray(any.steps)) walk(any.steps as RpaFlow['steps'])
    }
  }
  walk(flow?.steps ?? [])
  return n
}

function parseFlow(row: FlowRow): RpaFlow | null {
  try {
    const flow = JSON.parse(row.graph) as RpaFlow
    flow.id = row.id
    flow.name = row.name
    return flow
  } catch {
    return null
  }
}

export function listFlows(): FlowRecord[] {
  const rows = getDb().prepare('SELECT * FROM rpa_flows ORDER BY updated_at DESC').all() as FlowRow[]
  const lastRuns = new Map<string, RunRow>()
  for (const r of getDb().prepare('SELECT * FROM rpa_runs ORDER BY started_at DESC').all() as RunRow[]) {
    if (r.flow_id && !lastRuns.has(r.flow_id)) lastRuns.set(r.flow_id, r)
  }
  return rows.map((row) => {
    const flow = parseFlow(row)
    const steps = flow?.steps ?? []
    const last = lastRuns.get(row.id)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      flow: flow ?? { version: 1, id: row.id, name: row.name, steps: [] },
      stepCount: countSteps({ version: 1, name: row.name, steps }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: last?.started_at ?? null,
      lastRunStatus: last?.status ?? null
    }
  })
}

export function getFlow(id: string): RpaFlow | null {
  const row = getDb().prepare('SELECT * FROM rpa_flows WHERE id = ?').get(id) as FlowRow | undefined
  return row ? parseFlow(row) : null
}

export function createFlow(flow: RpaFlow): FlowRecord {
  const id = flow.id || newId('flow')
  const ts = now()
  const payload: RpaFlow = { ...flow, id, version: flow.version ?? 1 }
  getDb()
    .prepare('INSERT INTO rpa_flows (id, name, description, graph, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, payload.name, payload.description ?? null, JSON.stringify(payload), ts, ts)
  return {
    id,
    name: payload.name,
    description: payload.description ?? null,
    flow: payload,
    stepCount: countSteps(payload),
    createdAt: ts,
    updatedAt: ts,
    lastRunAt: null,
    lastRunStatus: null
  }
}

export function updateFlow(id: string, flow: RpaFlow): FlowRecord | null {
  const existing = getDb().prepare('SELECT * FROM rpa_flows WHERE id = ?').get(id) as FlowRow | undefined
  if (!existing) return null
  const payload: RpaFlow = { ...flow, id, version: flow.version ?? 1 }
  const ts = now()
  getDb()
    .prepare('UPDATE rpa_flows SET name = ?, description = ?, graph = ?, updated_at = ? WHERE id = ?')
    .run(payload.name, payload.description ?? null, JSON.stringify(payload), ts, id)
  return {
    id,
    name: payload.name,
    description: payload.description ?? null,
    flow: payload,
    stepCount: countSteps(payload),
    createdAt: existing.created_at,
    updatedAt: ts,
    lastRunAt: null,
    lastRunStatus: null
  }
}

export function deleteFlow(id: string): void {
  getDb().prepare('DELETE FROM rpa_flows WHERE id = ?').run(id)
}

export function startRun(runId: string, flowId: string, profileId: string, flowName: string): void {
  getDb()
    .prepare('INSERT INTO rpa_runs (id, flow_id, status, started_at, finished_at, log_path, stats) VALUES (?,?,?,?,?,?,?)')
    .run(runId, flowId, 'running', now(), null, null, JSON.stringify({ profileId, flowName }))
}

export function finishRun(run: RunResult, logPath: string | null): void {
  const payload: StatsBlob = {
    profileId: run.profileId,
    flowName: run.flowName,
    ok: run.stats.ok,
    failed: run.stats.failed,
    skipped: run.stats.skipped,
    retried: run.stats.retried,
    durationMs: run.stats.durationMs,
    error: run.error,
    files: run.files
  }
  getDb()
    .prepare('UPDATE rpa_runs SET status = ?, finished_at = ?, log_path = ?, stats = ? WHERE id = ?')
    .run(run.status, run.finishedAt ?? now(), logPath, JSON.stringify(payload), run.id)
}

function toSummary(r: RunRow): RunSummary {
  let stats: StatsBlob = {}
  try {
    stats = JSON.parse(r.stats ?? '{}') as StatsBlob
  } catch {
    // 老数据或写坏的数据按空统计处理，列表仍要能显示
  }
  return {
    id: r.id,
    flowId: r.flow_id ?? '',
    flowName: stats.flowName ?? r.flow_id ?? '',
    profileId: stats.profileId ?? '',
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ok: stats.ok ?? 0,
    failed: stats.failed ?? 0,
    skipped: stats.skipped ?? 0,
    durationMs: stats.durationMs ?? Math.max(0, (r.finished_at ?? r.started_at) - r.started_at),
    logPath: r.log_path,
    error: stats.error ?? null
  }
}

export function listRuns(limit = 50): RunSummary[] {
  const rows = getDb().prepare('SELECT * FROM rpa_runs ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[]
  return rows.map(toSummary)
}

/** 本次运行的完整步骤日志（存在文件里，库里只记路径） */
export function getRunLog(runId: string): { summary: RunSummary | null; log: unknown[]; files: string[] } | null {
  const row = getDb().prepare('SELECT * FROM rpa_runs WHERE id = ?').get(runId) as RunRow | undefined
  if (!row) return null
  const summary = toSummary(row)
  let log: unknown[] = []
  let files: string[] = []
  try {
    const stats = JSON.parse(row.stats ?? '{}') as StatsBlob
    files = stats.files ?? []
  } catch {
    files = []
  }
  if (row.log_path) {
    try {
      log = JSON.parse(fs.readFileSync(row.log_path, 'utf8')) as unknown[]
    } catch {
      log = []
    }
  }
  return { summary, log, files }
}