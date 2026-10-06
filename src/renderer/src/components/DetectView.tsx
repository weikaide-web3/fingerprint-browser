import { useEffect, useMemo, useState } from 'react'
import { useApp, useDetect } from '../store'
import { formatTime } from '../lib/format'
import type { DetectItem, DetectStatus } from '@shared/detect'

const STATUS_TEXT: Record<DetectStatus, string> = { ok: '一致', mismatch: '不一致', unknown: '未采集' }
const STATUS_CLASS: Record<DetectStatus, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  mismatch: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  unknown: 'bg-slate-700/40 text-slate-400 border-slate-600/40'
}

// field constant removed – using .input class directly in JSX

function scoreClass(score: number): string {
  if (score >= 90) return 'text-emerald-300'
  if (score >= 70) return 'text-amber-300'
  return 'text-rose-300'
}

export default function DetectView(): React.JSX.Element {
  const { profiles, load: loadProfiles } = useApp()
  const { profileId, running, report, error, onlyIssues, select, toggleOnlyIssues, run } = useDetect()
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    if (!profileId && profiles.length) select(profiles[0].id)
  }, [profiles, profileId, select])

  const groups = useMemo(() => {
    if (!report) return []
    const visible = report.items.filter((i) => (onlyIssues ? i.status !== 'ok' : true))
    const map = new Map<string, DetectItem[]>()
    for (const item of visible) {
      const list = map.get(item.group) ?? []
      list.push(item)
      map.set(item.group, list)
    }
    return [...map.entries()]
  }, [report, onlyIssues])

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <select value={profileId} onChange={(e) => select(e.target.value)} className="input">
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button
          onClick={() => void run(profileId, 2)}
          disabled={running || !profileId}
          className="btn btn-primary"
        >
          {running ? '检测中（正在拉起内核）…' : '🔍 开始检测'}
        </button>
        {report && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
              <input type="checkbox" checked={onlyIssues} onChange={toggleOnlyIssues} />
              只看问题项
            </label>
            <button onClick={() => setShowRaw((v) => !v)} className="btn btn-sm btn-ghost">
              {showRaw ? '隐藏原始信号' : '原始信号'}
            </button>
          </>
        )}
      </header>

      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-4 py-2.5 text-sm text-rose-200 animate-fade-in">{error}</div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4">
        {!report ? (
          <div className="card p-6 text-sm text-slate-400 leading-relaxed animate-fade-in">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-2xl">🔍</span>
              <span className="text-base font-medium text-slate-200">指纹检测</span>
            </div>
            选一个环境后点「开始检测」：系统会在该环境的真实内核里打开内置探针页，
            把 47 项信号读一遍，再和 profile 里的期望逐项比对。
            <br />
            环境没在运行时会自动临时以 headless 拉起同一个环境，测完即关。
            <br />
            <span className="text-slate-500 mt-2 block">
              Canvas / Audio 噪声会采样两次 —— 两次不一致说明噪声在漂移，同一环境会被网站判定成新设备。
            </span>
          </div>
        ) : (
          <>
            <div className="card p-5 flex flex-wrap items-center gap-5 animate-fade-in">
              <div className={`text-4xl font-bold tabular-nums ${scoreClass(report.score)}`}>{report.score}</div>
              <div className="text-xs text-slate-400 leading-relaxed">
                <span className="text-sm font-medium text-slate-200">{report.name}</span> · {formatTime(report.collectedAt)} · 采样 {report.samples} 次
                {report.kernel && (
                  <>
                    <br />
                    内核：{report.kernel.version}
                    {report.kernel.patched
                      ? ` · 补丁内核 level=${report.kernel.patchLevel}`
                      : report.kernel.branded
                        ? ' · 正式版 Chrome'
                        : ' · 未品牌化构建（媒体能力/更新通道会露馅）'}
                  </>
                )}
                <br />
                <span className="text-emerald-300">{report.ok} 项一致</span> ·{' '}
                <span className="text-rose-300">{report.mismatch} 项不一致</span> ·{' '}
                <span className="text-slate-400">{report.unknown} 项未采集</span>
              </div>
            </div>

            {groups.map(([group, items]) => (
              <section key={group} className="mt-4">
                <h3 className="text-xs font-semibold text-slate-300">{group}</h3>
                <table className="mt-1 w-full border-collapse text-sm">
                  <thead className="text-slate-400 text-xs">
                    <tr className="text-left">
                      <th className="py-1.5">信号</th>
                      <th className="py-1.5">期望（profile）</th>
                      <th className="py-1.5">实测（内核）</th>
                      <th className="py-1.5 text-right">结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.key} className="border-t border-slate-800/70 align-top">
                        <td className="py-1.5 pr-3">
                          <div>{item.label}</div>
                          {item.note && <div className="text-[11px] text-slate-500">{item.note}</div>}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-slate-400 break-all">{item.expected}</td>
                        <td className={`py-1.5 pr-3 font-mono text-xs break-all ${item.status === 'mismatch' ? 'text-rose-300' : 'text-slate-300'}`}>
                          {item.actual}
                        </td>
                        <td className="py-1.5 text-right">
                          <span className={`inline-block rounded border px-2 py-0.5 text-[11px] ${STATUS_CLASS[item.status]}`}>
                            {STATUS_TEXT[item.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}

            {showRaw && (
              <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-slate-950/70 border border-slate-800 p-3 text-[11px] font-mono text-slate-400">
                {JSON.stringify(report.snapshot, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </>
  )
}