import { useEffect, useState } from 'react'
import { useScheduler, useApp } from '../store'
import type { FlowRecord } from '@shared/rpa'

const CRON_PRESETS = [
  { label: '每小时', value: '0 * * * *' },
  { label: '每天 9:00', value: '0 9 * * *' },
  { label: '每天 0:00', value: '0 0 * * *' },
  { label: '每周一 9:00', value: '0 9 * * 1' },
  { label: '每 30 分钟', value: '*/30 * * * *' }
]

export default function SchedulerView(): React.JSX.Element {
  const { schedules, loading, error, load, remove, toggle, runNow } = useScheduler()
  const { profiles } = useApp()
  const [flows, setFlows] = useState<FlowRecord[]>([])
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    void load()
    void window.api.rpa.list().then(setFlows)
  }, [load])

  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#0d1117]/50">
        <div>
          <h2 className="text-lg font-semibold text-white">定时调度</h2>
          <p className="text-xs text-slate-400 mt-0.5">按 cron 表达式定时执行 RPA 流程</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>+ 新建定时任务</button>
      </div>
      {error && <div className="mx-6 mt-4 rounded-lg bg-rose-500/15 border border-rose-500/30 px-4 py-2 text-sm text-rose-300 animate-fade-in">{error}</div>}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="text-center text-slate-500 py-12">加载中...</div>
        ) : schedules.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">⏰</div>
            <p className="text-slate-400">暂无定时任务</p>
            <p className="text-xs text-slate-500 mt-1">创建定时任务，让 RPA 流程按计划自动运行</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 uppercase tracking-wider">
                  <th className="px-4 py-3">流程</th>
                  <th className="px-4 py-3">环境</th>
                  <th className="px-4 py-3">Cron</th>
                  <th className="px-4 py-3">下次运行</th>
                  <th className="px-4 py-3">状态</th>
                  <th className="px-4 py-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className="border-t border-[#1e293b] hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3 text-white">{s.flowName}</td>
                    <td className="px-4 py-3 text-slate-400">{profileName(s.profileId)}</td>
                    <td className="px-4 py-3"><code className="text-xs bg-slate-800 px-1.5 py-0.5 rounded">{s.cron}</code></td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '-'}</td>
                    <td className="px-4 py-3">
                      <button className={'badge cursor-pointer ' + (s.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700/60 text-slate-400')} onClick={() => void toggle(s.id, !s.enabled)}>
                        {s.enabled ? '已启用' : '已暂停'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        <button className="btn btn-ghost btn-xs" onClick={() => void runNow(s.id)}>立即运行</button>
                        <button className="btn btn-ghost btn-xs text-rose-400 hover:text-rose-300" onClick={() => void remove(s.id)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {showForm && <CreateScheduleDialog flows={flows} profiles={profiles} onClose={() => setShowForm(false)} />}
    </div>
  )
}

function CreateScheduleDialog({ flows, profiles, onClose }: {
  flows: FlowRecord[]
  profiles: { id: string; name: string }[]
  onClose(): void
}): React.JSX.Element {
  const { create } = useScheduler()
  const [flowId, setFlowId] = useState(flows[0]?.id ?? '')
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '')
  const [cron, setCron] = useState('0 9 * * *')
  const field = 'input'

  const submit = async (): Promise<void> => {
    if (!flowId || !profileId || !cron) return
    await create({ flowId, profileId, cron, enabled: true })
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-panel" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-white font-semibold mb-4">新建定时任务</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-slate-400">RPA 流程</label>
            <select className={field} value={flowId} onChange={(e) => setFlowId(e.target.value)}>
              {flows.length === 0 && <option value="">暂无流程，请先在 RPA 页创建</option>}
              {flows.map((f) => (<option key={f.id} value={f.id}>{f.name}</option>))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400">环境</label>
            <select className={field} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400">Cron 表达式</label>
            <input className={field} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {CRON_PRESETS.map((p) => (
                <button key={p.value} className="btn btn-ghost btn-xs" onClick={() => setCron(p.value)}>{p.label}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={!flowId || !profileId}>创建</button>
        </div>
      </div>
    </div>
  )
}

