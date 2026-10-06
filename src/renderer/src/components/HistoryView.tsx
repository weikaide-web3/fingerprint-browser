import { useEffect, useState } from 'react'
import { useHistory } from '../store'

const ACTION_LABEL: Record<string, string> = {
  'profile.create': '创建环境',
  'profile.update': '修改环境',
  'profile.delete': '删除环境',
  'profile.duplicate': '克隆环境',
  'profile.open': '打开环境',
  'profile.close': '关闭环境',
  'proxy.create': '创建代理',
  'proxy.update': '修改代理',
  'proxy.delete': '删除代理',
  'proxy.check': '检测代理',
  'detect.run': '指纹检测',
  'tls.probe': 'TLS 观测',
  'settings.set': '修改设置',
  'settings.reset': '重置设置',
  'rpa.run': '执行 RPA',
  'api.user.create': 'API 创建环境',
  'api.user.delete': 'API 删除环境',
  'backup.create': '创建备份',
  'backup.restore': '恢复备份',
  'extension.install': '安装扩展',
  'extension.uninstall': '卸载扩展',
  'schedule.create': '创建定时任务',
  'schedule.run': '定时执行'
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

function ago(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

export default function HistoryView(): React.JSX.Element {
  const { entries, loading, error, load } = useHistory()
  const [kind, setKind] = useState<'all' | 'audit' | 'usage'>('all')

  useEffect(() => { void load({ limit: 200 }) }, [load])

  const filtered = entries.filter((e) => kind === 'all' || e.kind === kind)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#0d1117]/50">
        <div>
          <h2 className="text-lg font-semibold text-white">操作历史</h2>
          <p className="text-xs text-slate-400 mt-0.5">环境打开/关闭、配置修改、检测等操作的完整记录</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-[#1e293b] overflow-hidden">
            {(['all', 'audit', 'usage'] as const).map((k) => (
              <button key={k} className={`px-3 py-1.5 text-xs transition-colors ${kind === k ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400 hover:bg-slate-800/50'}`} onClick={() => setKind(k)}>
                {k === 'all' ? '全部' : k === 'audit' ? '配置变更' : '使用记录'}
              </button>
            ))}
          </div>
          <button className="btn btn-secondary" onClick={() => void load({ limit: 200 })} disabled={loading}>↻ 刷新</button>
        </div>
      </div>
      {error && <div className="mx-6 mt-4 rounded-lg bg-rose-500/15 border border-rose-500/30 px-4 py-2 text-sm text-rose-300 animate-fade-in">{error}</div>}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading && entries.length === 0 ? (
          <div className="text-center text-slate-500 py-12">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📋</div>
            <p className="text-slate-400">暂无操作记录</p>
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((e) => (
              <div key={`${e.kind}-${e.id}`} className="flex items-center gap-3 px-4 py-2.5 rounded-lg hover:bg-slate-800/30 transition-colors">
                <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${e.kind === 'audit' ? 'bg-cyan-400' : 'bg-slate-500'}`} />
                <span className="text-sm text-slate-200 w-28 shrink-0">{actionLabel(e.action)}</span>
                {e.targetName && <span className="text-sm text-white font-medium truncate max-w-[200px]">{e.targetName}</span>}
                {e.detail && <span className="text-xs text-slate-500 truncate flex-1">{e.detail}</span>}
                <span className="text-xs text-slate-600 ml-auto shrink-0" title={new Date(e.ts).toLocaleString()}>{ago(e.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
