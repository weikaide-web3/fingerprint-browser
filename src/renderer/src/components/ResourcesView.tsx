import { useEffect, useState } from 'react'
import { useResources } from '../store'

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function ResourcesView(): React.JSX.Element {
  const { report, loading, error, load } = useResources()
  const [auto, setAuto] = useState(true)

  useEffect(() => {
    void load()
    if (!auto) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load, auto])

  const maxRss = Math.max(1, ...(report?.profiles.map((p) => p.totalRssBytes) ?? [1]))

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#0d1117]/50">
        <div>
          <h2 className="text-lg font-semibold text-white">资源监控</h2>
          <p className="text-xs text-slate-400 mt-0.5">实时查看各环境 Chrome 进程的内存与进程数占用</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-emerald-500" />
            自动刷新（5s）
          </label>
          <button className="btn btn-secondary" onClick={() => void load()} disabled={loading}>↻ 刷新</button>
        </div>
      </div>
      {error && <div className="mx-6 mt-4 rounded-lg bg-rose-500/15 border border-rose-500/30 px-4 py-2 text-sm text-rose-300 animate-fade-in">{error}</div>}
      <div className="flex-1 overflow-auto px-6 py-4">
        {!report ? (
          <div className="text-center text-slate-500 py-12">采集中...</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="card text-center py-4">
                <div className="text-2xl font-bold text-white">{fmtBytes(report.totalRssBytes)}</div>
                <div className="text-xs text-slate-400 mt-1">总内存占用</div>
              </div>
              <div className="card text-center py-4">
                <div className="text-2xl font-bold text-white">{report.runningCount}</div>
                <div className="text-xs text-slate-400 mt-1">运行中环境</div>
              </div>
              <div className="card text-center py-4">
                <div className="text-2xl font-bold text-white">{report.totalProcesses}</div>
                <div className="text-xs text-slate-400 mt-1">Chrome 进程总数</div>
              </div>
            </div>
            {report.profiles.filter((p) => p.running).length === 0 ? (
              <div className="text-center py-12 text-slate-500">当前没有运行中的环境</div>
            ) : (
              <div className="space-y-2">
                {report.profiles.filter((p) => p.running).sort((a, b) => b.totalRssBytes - a.totalRssBytes).map((p) => (
                  <div key={p.profileId} className="card px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse-dot" />
                        <span className="text-sm text-white font-medium">{p.name}</span>
                        <span className="text-xs text-slate-500">{p.processCount} 个进程</span>
                      </div>
                      <span className="text-sm text-slate-300">{fmtBytes(p.totalRssBytes)}</span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full transition-all" style={{ width: `${(p.totalRssBytes / maxRss) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="text-[11px] text-slate-600 mt-4">采集时间：{new Date(report.checkedAt).toLocaleString()}</div>
          </>
        )}
      </div>
    </div>
  )
}
