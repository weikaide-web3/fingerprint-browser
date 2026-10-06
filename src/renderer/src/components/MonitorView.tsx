import { useEffect } from 'react'
import { useMonitor } from '../store'

export default function MonitorView(): React.JSX.Element {
  const { alerts, loading, error, load, runProxy, runCookie, runDrift } = useMonitor()

  useEffect(() => { void load() }, [load])

  const proxyCount = alerts?.proxyFailed.length ?? 0
  const cookieCount = alerts?.cookieExpiring.length ?? 0
  const driftCount = alerts?.drift.length ?? 0
  const total = proxyCount + cookieCount + driftCount

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#0d1117]/50">
        <div>
          <h2 className="text-lg font-semibold text-white">监控告警</h2>
          <p className="text-xs text-slate-400 mt-0.5">代理失效、Cookie 过期、指纹漂移的主动检测与提醒</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary" onClick={() => void runCookie()} disabled={loading}>检查 Cookie</button>
          <button className="btn btn-secondary" onClick={() => void runProxy()} disabled={loading}>检测代理</button>
          <button className="btn btn-primary" onClick={() => void runDrift()} disabled={loading}>检测漂移</button>
        </div>
      </div>
      {error && <div className="mx-6 mt-4 rounded-lg bg-rose-500/15 border border-rose-500/30 px-4 py-2 text-sm text-rose-300 animate-fade-in">{error}</div>}
      <div className="flex-1 overflow-auto px-6 py-4">
        {!alerts ? (
          <div className="text-center text-slate-500 py-12">加载中...</div>
        ) : total === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">✅</div>
            <p className="text-slate-400">一切正常，没有发现需要处理的问题</p>
          </div>
        ) : (
          <div className="space-y-5">
            {proxyCount > 0 && (
              <Section title="失效代理" count={proxyCount} color="rose">
                {alerts.proxyFailed.map((p) => (
                  <Row key={p.id} primary={p.name} secondary={p.error} />
                ))}
              </Section>
            )}
            {cookieCount > 0 && (
              <Section title="Cookie 即将过期 / 已过期" count={cookieCount} color="amber">
                {alerts.cookieExpiring.map((c) => (
                  <Row key={c.profileId} primary={c.name} secondary={c.expired ? '已过期' : c.daysLeft != null ? `${c.daysLeft} 天后过期` : '无到期时间'} />
                ))}
              </Section>
            )}
            {driftCount > 0 && (
              <Section title="指纹漂移" count={driftCount} color="rose">
                {alerts.drift.map((d) => (
                  <Row key={d.profileId} primary={d.name} secondary={`检测分从 ${d.from} 降到 ${d.to}（-${d.drop}）`} />
                ))}
              </Section>
            )}
          </div>
        )}
        {alerts && (
          <div className="text-[11px] text-slate-600 mt-6 space-x-4">
            {alerts.lastProxyCheckAt && <span>上次代理检测：{new Date(alerts.lastProxyCheckAt).toLocaleString()}</span>}
            {alerts.lastDriftCheckAt && <span>上次漂移检测：{new Date(alerts.lastDriftCheckAt).toLocaleString()}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, count, color, children }: { title: string; count: number; color: 'rose' | 'amber'; children: React.ReactNode }): React.JSX.Element {
  const badge = color === 'rose' ? 'bg-rose-500/20 text-rose-300' : 'bg-amber-500/20 text-amber-300'
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className={`badge ${badge}`}>{count}</span>
      </div>
      <div className="card divide-y divide-[#1e293b]">{children}</div>
    </div>
  )
}

function Row({ primary, secondary }: { primary: string; secondary: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-sm text-white">{primary}</span>
      <span className="text-xs text-slate-400">{secondary}</span>
    </div>
  )
}
