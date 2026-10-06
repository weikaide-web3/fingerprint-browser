import { queryAudit, queryUsage } from '../db/repositories/settings'
import { listProfiles } from '../db/repositories/profiles'
import type { HistoryEntry } from '@shared/ops'

/**
 * 操作历史：把 audit_logs（配置/管理操作）和 usage_logs（环境打开/关闭）
 * 合并成一条按时间倒序的时间线，并补上可读的名字。
 */

const ACTION_LABELS: Record<string, string> = {
  'profile.create': '创建环境',
  'profile.update': '修改环境',
  'profile.delete': '删除环境',
  'profile.duplicate': '克隆环境',
  'profile.fingerprint': '更新指纹',
  'proxy.create': '创建代理',
  'proxy.update': '修改代理',
  'proxy.delete': '删除代理',
  'proxy.check': '检测代理',
  'settings.set': '修改设置',
  'settings.reset': '重置设置',
  'api.start': '启动 API',
  'api.stop': '停止 API',
  'rpa.run': '运行流程',
  'rpa.create': '创建流程',
  'rpa.update': '修改流程',
  'rpa.delete': '删除流程',
  'ext.install': '安装扩展',
  'ext.uninstall': '卸载扩展',
  'ext.bind': '绑定扩展',
  'ext.unbind': '解绑扩展',
  'account.create': '添加账号',
  'account.update': '修改账号',
  'account.delete': '删除账号',
  'backup.create': '创建备份',
  'backup.restore': '恢复备份',
  open: '打开环境',
  close: '关闭环境'
}

function labelFor(action: string): string {
  return ACTION_LABELS[action] ?? action
}

export function history(opts: { limit?: number; profileId?: string } = {}): HistoryEntry[] {
  const limit = opts.limit ?? 200
  const profiles = listProfiles({ limit: 100000 }).items
  const nameById = new Map(profiles.map((p) => [p.id, p.name]))

  const audit = queryAudit({ limit }).map((r) => ({
    id: `a${r.id}`,
    ts: r.ts,
    kind: 'audit' as const,
    action: r.action,
    label: labelFor(r.action),
    targetName: r.targetId ? nameById.get(r.targetId) ?? null : null,
    detail: r.detail
  }))

  const usage = queryUsage({ limit, profileId: opts.profileId }).map((r) => ({
    id: `u${r.id}`,
    ts: r.ts,
    kind: 'usage' as const,
    action: r.action,
    label: labelFor(r.action),
    targetName: nameById.get(r.profileId) ?? r.profileId,
    detail: r.detail
  }))

  return [...audit, ...usage].sort((a, b) => b.ts - a.ts).slice(0, limit)
}
