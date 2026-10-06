import { useEffect, useMemo, useState } from 'react'
import { useApp, useTls } from '../store'
import { formatTime } from '../lib/format'
import type { DetectItem, DetectStatus } from '@shared/detect'

const STATUS_CLASS: Record<DetectStatus, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  mismatch: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  unknown: 'bg-slate-700/40 text-slate-400 border-slate-600/40'
}
const STATUS_TEXT: Record<DetectStatus, string> = { ok: '一致', mismatch: '不一致', unknown: '未采集' }

const field = 'input'

function scoreClass(score: number): string {
  if (score >= 90) return 'text-emerald-300'
  if (score >= 70) return 'text-amber-300'
  return 'text-rose-300'
}

function Row({ k, v, mono, hint }: { k: string; v: string; mono?: boolean; hint?: string }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-slate-500">{k}</dt>
      <dd className={`min-w-0 break-all ${mono ? 'font-mono text-slate-200' : 'text-slate-300'}`}>
        {v}
        {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
      </dd>
    </div>
  )
}

export default function TlsView(): React.JSX.Element {
  const { profiles, load: loadProfiles } = useApp()
  const { profileId, running, report, baselines, history, error, notice, select, load, probe, promote } = useTls()
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    void loadProfiles()
    void load()
  }, [loadProfiles, load])

  useEffect(() => {
    if (!profileId && profiles.length) select(profiles[0].id)
  }, [profiles, profileId, select])

  const groups = useMemo(() => {
    if (!report) return []
    const map = new Map<string, DetectItem[]>()
    for (const item of report.items) {
      const list = map.get(item.group) ?? []
      list.push(item)
      map.set(item.group, list)
    }
    return [...map.entries()]
  }, [report])

  const primary = report?.observations.find((o) => o.via === 'tap') ?? report?.observations[0] ?? null

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <select value={profileId} onChange={(e) => select(e.target.value)} className={field}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => void probe(profileId)}
          disabled={running || !profileId}
          className="btn btn-primary px-3 py-1.5 text-sm font-medium disabled:opacity-40"
        >
          {running ? '观测中（会临时重启内核）…' : '观测 TLS / HTTP2'}
        </button>
        {report && (
          <>
            <button onClick={() => void promote()} className=" btn btn-secondary px-3 py-1.5 text-sm">
              设为本机基线
            </button>
            <button onClick={() => setShowRaw((v) => !v)} className=" btn btn-secondary px-3 py-1.5 text-sm">
              {showRaw ? '隐藏原始数据' : '原始数据'}
            </button>
          </>
        )}
      </header>

      {notice && (
        <div className="mx-5 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2 text-sm text-rose-200">{error}</div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4">
        {!report ? (
          <div className="card p-5 text-sm text-slate-400 leading-relaxed">
            Google 与 X（前置 Cloudflare）在<b className="text-slate-200">服务端</b>记录 TLS ClientHello（JA3/JA4）与 HTTP/2
            SETTINGS，并把它们当作 bot score 的主要输入。这些信号在 JS 层完全读不到，所以只能被动观测：
            <br />
            点「观测」后，环境会被临时指向一个本机 tap —— 它偷看 ClientHello 后原样转发，再接环境真实绑定的代理，
            因此看到的正是服务端看到的形状。
            <br />
            <span className="text-slate-500">
              本工具不改写 ClientHello：伪造的握手通常缺 GREASE、扩展顺序僵硬，比「内核版本与 UA 不一致」更容易被判定为机器人。
              要做的是把矛盾暴露出来 —— 尤其是 UA 声明版本 ≠ 内核实测版本。
            </span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-4 card p-4">
              <div className={`text-3xl font-semibold tabular-nums ${scoreClass(report.score)}`}>{report.score}</div>
              <div className="text-xs text-slate-400 leading-relaxed">
                {report.name} · 内核 {report.kernelVersion} · {formatTime(report.at)}
                <br />
                <span className="text-emerald-300">{report.ok} 项一致</span> ·{' '}
                <span className="text-rose-300">{report.mismatch} 项不一致</span> ·{' '}
                <span className="text-slate-400">{report.unknown} 项未采集</span>
                <br />
                <span className="font-mono text-slate-500">目标 {report.targetUrl}</span>
              </div>
              {report.baseline && (
                <div className="ml-auto text-xs text-slate-400 leading-relaxed text-right">
                  本机基线 {report.baseline.kernelVersion}
                  <br />
                  <span className="font-mono">{report.baseline.ja4}</span>
                  <br />
                  <span className="text-slate-500">
                    样本 {report.baseline.samples} · {formatTime(report.baseline.observedAt)}
                  </span>
                </div>
              )}
            </div>

            {primary && (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="card p-3">
                  <h3 className="text-xs font-semibold text-slate-300">TLS ClientHello（{primary.via}）</h3>
                  <dl className="mt-2 space-y-1 text-xs">
                    <Row k="JA4" v={primary.tls.ja4} mono />
                    <Row k="JA4r" v={primary.tls.ja4r} mono />
                    <Row k="JA3" v={primary.tls.ja3} mono />
                    <Row k="最高版本" v={primary.tls.versionLabel} />
                    <Row k="ALPN" v={primary.tls.alpn.join(' / ') || '（无）'} />
                    <Row k="套件 / 扩展" v={`${primary.tls.cipherCount} / ${primary.tls.extensionCount}`} />
                    <Row k="GREASE 项" v={String(primary.tls.greaseCount)} hint="真实 Chrome 一定 > 0；为 0 通常是中间设备重写了握手" />
                    <Row k="SNI" v={primary.tls.sni ?? '（无 SNI）'} />
                  </dl>
                  <div className="mt-2 text-[11px] text-slate-500 font-mono break-all leading-relaxed">{primary.tls.ja3String}</div>
                </div>

                <div className="card p-3">
                  <h3 className="text-xs font-semibold text-slate-300">HTTP/2 SETTINGS</h3>
                  {!primary.h2 ? (
                    <div className="mt-2 text-xs text-slate-500 leading-relaxed">
                      本次没拿到 H2 帧：tap 只能看到 ClientHello。要看 SETTINGS，需让环境走明文 http 或本机 HTTPS 源。
                    </div>
                  ) : (
                    <>
                      <dl className="mt-2 space-y-1 text-xs">
                        <Row k="preface" v={primary.h2.preface ? '是' : '否'} />
                        <Row k="WINDOW_UPDATE" v={primary.h2.windowUpdate === null ? '—' : String(primary.h2.windowUpdate)} />
                        <Row k="前置帧序" v={primary.h2.preludeFrames.join(', ') || '（无）'} />
                        <Row k="H2 指纹" v={primary.h2.fp} mono />
                      </dl>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {primary.h2.settings.map((s) => (
                          <span key={s.id} className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[11px] font-mono text-slate-300">
                            {s.id}={s.value}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
            {report.echo && (
              <div className="mt-3 card p-3 text-xs">
                <h3 className="text-xs font-semibold text-slate-300">第三方回显（服务端真实所见）</h3>
                <dl className="mt-2 space-y-1">
                  <Row k="来源" v={report.echo.url} />
                  <Row k="JA4" v={report.echo.ja4 ?? '—'} mono />
                  <Row k="JA3" v={report.echo.ja3 ?? '—'} mono />
                  <Row k="H2" v={report.echo.h2fp ?? '—'} mono />
                  <Row k="HTTP 版本" v={report.echo.httpVersion ?? '—'} />
                </dl>
                <div className="mt-1.5 text-[11px] text-slate-500">
                  回显与本机观测不一致，说明中间有设备在做 TLS 终结（代理 MITM、企业网关、杀软）—— 这会让所有 TLS 指纹努力作废。
                </div>
              </div>
            )}

            {groups.map(([group, items]) => (
              <section key={group} className="mt-4">
                <h3 className="text-xs font-semibold text-slate-300">{group}</h3>
                <table className="mt-1 w-full border-collapse text-sm">
                  <thead className="text-slate-400 text-xs">
                    <tr className="text-left">
                      <th className="py-1.5">信号</th>
                      <th className="py-1.5">期望</th>
                      <th className="py-1.5">实测</th>
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
                        <td
                          className={`py-1.5 pr-3 font-mono text-xs break-all ${
                            item.status === 'mismatch' ? 'text-rose-300' : 'text-slate-300'
                          }`}
                        >
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

            {baselines.length > 0 && (
              <section className="mt-4">
                <h3 className="text-xs font-semibold text-slate-300">已记录的内核基线</h3>
                <table className="mt-1 w-full border-collapse text-sm">
                  <thead className="text-slate-400 text-xs">
                    <tr className="text-left">
                      <th className="py-1.5">内核</th>
                      <th className="py-1.5">JA4</th>
                      <th className="py-1.5">H2</th>
                      <th className="py-1.5">GREASE</th>
                      <th className="py-1.5 text-right">样本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {baselines.map((b) => (
                      <tr key={b.kernelVersion} className="border-t border-slate-800/70">
                        <td className="py-1.5 pr-3">{b.kernelVersion}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-slate-300">{b.ja4}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-slate-400">{b.h2fp ?? '—'}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-slate-400">{b.greaseCount}</td>
                        <td className="py-1.5 text-right font-mono text-xs text-slate-400">{b.samples}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {history.length > 0 && (
              <section className="mt-4">
                <h3 className="text-xs font-semibold text-slate-300">该环境的历史观测</h3>
                <div className="mt-1 space-y-1">
                  {history.map((o) => (
                    <div key={o.id} className="flex flex-wrap items-center gap-2 text-xs border-t border-slate-800/70 py-1.5">
                      <span className="text-slate-500">{formatTime(o.observedAt)}</span>
                      <span className="rounded bg-slate-800/70 px-1.5 py-0.5 text-[10px]">{o.via}</span>
                      <span className="font-mono text-slate-300">{o.tls.ja4}</span>
                      <span className="font-mono text-slate-500">{o.h2?.fp ?? 'h2 —'}</span>
                      <span className="text-slate-500">{o.host}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {showRaw && (
              <pre className="mt-4 max-h-96 overflow-auto rounded-lg bg-slate-950/70 border border-slate-800 p-3 text-[11px] font-mono text-slate-400">
                {JSON.stringify({ observations: report.observations, echo: report.echo }, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </>
  )
}