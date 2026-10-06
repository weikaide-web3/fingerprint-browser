import { useEffect, useState } from 'react'
import { useHealth } from '../store'
import type { HealthFactor, HealthLevel, ProfileHealth } from '@shared/ops'

const LEVEL_COLOR: Record<HealthLevel, string> = {
  good: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-rose-300'
}
const LEVEL_BG: Record<HealthLevel, string> = {
  good: 'bg-emerald-500/20 text-emerald-300',
  warn: 'bg-amber-500/20 text-amber-300',
  bad: 'bg-rose-500/20 text-rose-300'
}
const LEVEL_LABEL: Record<HealthLevel, string> = { good: '良好', warn: '注意', bad: '异常' }

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400'
  if (score >= 60) return 'text-amber-400'
  return 'text-rose-400'
}

export default function HealthView(): React.JSX.Element {
  const { summary, loading, error, load } = useHealth()
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => { void load() }, [load])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#0d1117]/50">
        <div>
          <h2 className="text-lg font-semibold text-white">环境健康度</h2>
          <p className="text-xs text-slate-400 mt-0.5">综合指纹一致性、代理质量、登录态新鲜度、关联风险给出评分</p>
        </div>
        <button className="btn btn-secondary" onClick={() => void load()} disabled={loading}>{loading ? '检测中...' : '↻ 重新检测'}</button>
      </div>
      {error && <div className="mx-6 mt-4 rounded-lg bg-rose-500/15 border border-rose-500/30 px-4 py-2 text-sm text-rose-300 animate-fade-in">{error}</div>}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading && !summary ? (
          <div className="text-center text-slate-500 py-12">检测中...</div>
        ) : !summary || summary.total === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">🩺</div>
            <p className="text-slate-400">暂无环境</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-3 mb-5">
              <div className="card text-center py-4">
                <div className="text-2xl font-bold text-white">{summary.total}</div>
                <div className="text-xs text-slate-400 mt-1">环境总数</div>
              </div>
              <div className="card text-center py-4">
                <div className="text-2xl font-bold text-emerald-400">{summary.good}</div>
                <div className="text-xs text-slate-400 mt-1">良好</div>
              </div>
              <div className="card text-center py-4">
                <div className="text-2xl font-bold text-amber-400">{summary.warn}</div>
                <div className="text-xs text-slate-400 mt-1">需注意</div>
              </div>
              <div className="card text-center py-4">
                <div className="text-2xl font-bold text-rose-400">{summary.bad}</div>
                <div className="text-xs text-slate-400 mt-1">异常</div>
              </div>
            </div>
            <div className="table-container">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400 uppercase tracking-wider">
                    <th className="px-4 py-3">环境</th>
                    <th className="px-4 py-3">健康分</th>
                    <th className="px-4 py-3">等级</th>
                    <th className="px-4 py-3">检测时间</th>
                    <th className="px-4 py-3 text-right">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.items.map((h) => (
                    <HealthRow key={h.profileId} h={h} expanded={expanded === h.profileId} onToggle={() => setExpanded(expanded === h.profileId ? null : h.profileId)} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function HealthRow({ h, expanded, onToggle }: { h: ProfileHealth; expanded: boolean; onToggle(): void }): React.JSX.Element {
  return (
    <>
      <tr className="border-t border-[#1e293b] hover:bg-slate-800/30 transition-colors cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-3 text-white font-medium">{h.name}</td>
        <td className="px-4 py-3">
          <span className={`font-bold ${scoreColor(h.score)}`}>{h.score}</span>
          <span className="text-slate-600 text-xs">/100</span>
        </td>
        <td className="px-4 py-3"><span className={`badge ${LEVEL_BG[h.level]}`}>{LEVEL_LABEL[h.level]}</span></td>
        <td className="px-4 py-3 text-xs text-slate-400">{new Date(h.checkedAt).toLocaleString()}</td>
        <td className="px-4 py-3 text-right text-slate-400 text-xs">{expanded ? '收起 ▲' : '展开 ▼'}</td>
      </tr>
      {expanded && (
        <tr className="bg-slate-900/40">
          <td colSpan={5} className="px-6 py-3">
            <div className="grid grid-cols-2 gap-3">
              {h.factors.map((f) => <FactorCard key={f.key} f={f} />)}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function FactorCard({ f }: { f: HealthFactor }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className={`badge shrink-0 ${LEVEL_BG[f.level]}`}>{LEVEL_LABEL[f.level]}</span>
      <div>
        <div className="text-slate-200 font-medium">{f.label}{f.score != null && <span className={`ml-1 ${LEVEL_COLOR[f.level]}`}>{f.score}</span>}</div>
        <div className="text-slate-500 mt-0.5">{f.message}</div>
      </div>
    </div>
  )
}
