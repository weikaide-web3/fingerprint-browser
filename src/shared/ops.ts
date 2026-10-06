/** 新增运维/监控功能的共用类型（主进程实现 + 渲染进程消费） */
import type { FingerprintConfig, Profile, ProxyRecord } from './types'

// —— 定时调度 ——
export interface ScheduleRecord {
  id: string
  flowId: string
  flowName: string
  cron: string
  enabled: boolean
  params: Record<string, string>
  profileId: string
  nextRunAt: number | null
  lastRunAt: number | null
  createdAt: number
}

// —— 备份 / 恢复 ——
export interface BackupInfo {
  id: string
  name: string
  file: string
  sizeBytes: number
  createdAt: number
}

// —— 健康度 ——
export type HealthLevel = 'good' | 'warn' | 'bad'

export interface HealthFactor {
  key: 'fingerprint' | 'proxy' | 'session' | 'association'
  label: string
  level: HealthLevel
  score: number | null
  message: string
}

export interface ProfileHealth {
  profileId: string
  name: string
  score: number
  level: HealthLevel
  factors: HealthFactor[]
  checkedAt: number
}

export interface HealthSummary {
  total: number
  good: number
  warn: number
  bad: number
  items: ProfileHealth[]
  checkedAt: number
}

// —— 资源监控 ——
export interface ProcInfo {
  pid: number
  rssBytes: number
  cpuPercent: number
  role: string
}

export interface ProfileResource {
  profileId: string
  name: string
  running: boolean
  processCount: number
  totalRssBytes: number
  processes: ProcInfo[]
}

export interface ResourceReport {
  profiles: ProfileResource[]
  totalRssBytes: number
  totalProcesses: number
  runningCount: number
  checkedAt: number
}

// —— 环境导入 / 导出 ——
export interface ProfileBundle {
  version: 1
  exportedAt: number
  profile: {
    name: string
    color: string | null
    icon: string | null
    note: string | null
    kernel: Profile['kernel']
    fingerprintMode: Profile['fingerprintMode']
    proxyMode: Profile['proxyMode']
    startupUrls: string[]
    launchArgs: string[]
    sessionPolicy: Profile['sessionPolicy']
    retention: Profile['retention']
    tags: string[]
  }
  fingerprint: FingerprintConfig | null
  proxy: {
    name: string
    scheme: ProxyRecord['scheme']
    host: string
    port: number
    username: string | null
  } | null
}

export interface PortImportResult {
  profileId: string
  name: string
  proxyCreated: boolean
}

// —— 操作历史 ——
export interface HistoryEntry {
  id: string
  ts: number
  kind: 'audit' | 'usage'
  action: string
  label: string
  targetName: string | null
  detail: string | null
}

// —— 后台监控告警 ——
export interface MonitorAlerts {
  proxyFailed: { id: string; name: string; error: string }[]
  cookieExpiring: { profileId: string; name: string; daysLeft: number | null; expired: boolean }[]
  drift: { profileId: string; name: string; from: number; to: number; drop: number }[]
  lastProxyCheckAt: number | null
  lastDriftCheckAt: number | null
}

// —— 回收站 ——
export type TrashKind = 'profile' | 'proxy' | 'extension'

export interface TrashItem {
  kind: TrashKind
  id: string
  name: string
  deletedAt: number | null
  meta?: string
}