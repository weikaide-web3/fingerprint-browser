import { useEffect } from 'react'
import { useAssociation } from '../store'
import { formatTime } from '../lib/format'
import type { AssociationIssue, AssociationLevel } from '@shared/association'

const LEVEL_CLASS: Record<AssociationLevel, string> = {
  error: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  info: 'border-slate-700 bg-slate-800/40 text-slate-300'
}

const LEVEL_TEXT: Record<AssociationLevel, string> = { error: '严重', warn: '警告', info: '提示' }

/** 按 code 分组：同一类问题（比如共用出口）集中在一起看比按环境散开更好定位 */
function groupByCode(issues: AssociationIssue[]): [string, AssociationIssue[]][] {
  const map = new Map<string, AssociationIssue[]>()
  for (const i of issues) {
    const list = map.get(i.code) ?? []
    list.push(i)
    map.set(i.code, list)
  }
  const order: Record<AssociationLevel, number> = { error: 0, warn: 1, info: 2 }
  return [...map.entries()].sort((a, b) => order[a[1][0].level] - order[b[1][0].level])
}

function scoreClass(score: number): string {
  if (score >= 85) return 'text-emerald-300'
  if (score >= 60) return 'text-amber-300'
  return 'text-rose-300'
}

export default function AssociationView(): React.JSX.Element {
  const { report, loading, error, level, load, setLevel } = useAssociation()

  useEffect(() => {
    void load()
  }, [load])

  const shown = report ? (level === 'issue' ? report.issues.filter((i) => i.level !== 'info') : report.issues) : []

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <h2 className="text-sm font-semibold">关联隔离</h2>
        <span className="text-xs text-slate-500">检查「环境 ↔ 代理 ↔ 账号」三元组会不会互相出卖</span>
        {report && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" checked={level === 'all'} onChange={(e) => setLevel(e.target.checked ? 'all' : 'issue')} />
            显示提示级
          </label>
        )}
        <button onClick={() => void load()} className=" btn btn-secondary px-3 py-1.5 text-sm">
          {loading ? '检查中…' : '重新检查'}
        </button>
      </header>

      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2 text-sm text-rose-200">{error}</div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
        {!report ? (
          <div className="card p-5 text-sm text-slate-400 leading-relaxed">
            Google 与 X 判定机器人时看的不是单个指纹，而是「账号-设备-出口」这个三元组的组合关系。
            <br />
            两个环境各自指纹完美，但只要共用一个出口 IP、或同一个账号在两个环境登录过，服务端就能把整批账号当成一个人操作 ——
            一个被封，其余连坐。
            <br />
            <span className="text-slate-500">这一页回答的不是「这个环境像不像真人」，而是「这一批放在一起会不会互相出卖」。</span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-5 card p-4">
              <div className={`text-3xl font-semibold tabular-nums ${scoreClass(report.score)}`}>{report.score}</div>
              <div className="text-xs text-slate-400 leading-relaxed">
                {formatTime(report.checkedAt)} · 环境 {report.stats.profiles} · 账号 {report.stats.accounts} · 在用出口{' '}
                {report.stats.proxies}
                <br />
                <span className="text-rose-300">{report.errors} 项严重</span> ·{' '}
                <span className="text-amber-300">{report.warns} 项警告</span> ·{' '}
                <span className="text-slate-400">{report.infos} 项提示</span>
                <br />
                单代理最多 {report.limits.maxAccountsPerProxy} 个环境 · 单 IP 最多 {report.limits.maxAccountsPerIp} 个账号 ·
                休眠阈值 {report.limits.dormantDays} 天（在设置里改）
              </div>
              <div className="ml-auto text-xs text-slate-400 text-right leading-relaxed">
                单 IP 最多承载 <span className="text-slate-200">{report.stats.maxAccountsPerIp}</span> 个账号
                <br />
                被共用的出口 <span className="text-slate-200">{report.stats.sharedProxies}</span> 个 · 直连且有账号的环境{' '}
                <span className="text-slate-200">{report.stats.directConnectProfiles}</span> 个
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-200">
                没有发现已知关联风险。
              </div>
            ) : (
              groupByCode(shown).map(([code, items]) => (
                <section key={code} className="card">
                  <h3 className="section-header text-xs font-semibold text-slate-300">
                    {code} <span className="text-slate-500">· {items.length} 处</span>
                  </h3>
                  <div className="divide-y divide-slate-800/70">
                    {items.map((i, idx) => (
                      <div key={idx} className={`mx-3 my-2 rounded-md border px-3 py-2 text-sm ${LEVEL_CLASS[i.level]}`}>
                        <div className="flex items-start gap-2">
                          <span className="shrink-0 rounded bg-slate-900/60 px-1.5 py-0.5 text-[10px]">
                            {LEVEL_TEXT[i.level]}
                          </span>
                          <span className="leading-relaxed">{i.message}</span>
                        </div>
                        {(i.profileIds.length > 0 || i.proxyIds.length > 0 || i.accountIds.length > 0) && (
                          <div className="mt-1.5 text-[11px] text-slate-500 font-mono">
                            {i.profileIds.length > 0 && <span className="mr-3">环境 {i.profileIds.length}</span>}
                            {i.proxyIds.length > 0 && <span className="mr-3">代理 {i.proxyIds.length}</span>}
                            {i.accountIds.length > 0 && <span>账号 {i.accountIds.length}</span>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </div>
    </>
  )
}