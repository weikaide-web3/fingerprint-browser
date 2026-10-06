import { useEffect } from 'react'
import { useKernel } from '../store'
import type { KernelGapItem, KernelGapReport, KernelIdentity } from '@shared/kernel'

const FLAVOR_TEXT: Record<KernelIdentity['flavor'], string> = {
  'branded-chrome': '正式版 Chrome',
  'chrome-for-testing': 'Chrome for Testing（未品牌化）',
  chromium: 'Chromium（未品牌化）',
  patched: '自编译补丁内核',
  unknown: '未知'
}

const SOURCE_TEXT: Record<KernelIdentity['source'], string> = {
  setting: '设置里的自定义内核路径',
  branded: '本机正式版 Chrome',
  playwright: 'Playwright 注册表',
  cache: 'Playwright 缓存扫描',
  none: '未找到内核'
}

const STATUS_TEXT: Record<KernelGapItem['status'], string> = {
  covered: '已覆盖',
  partial: '部分覆盖',
  'kernel-only': '仅内核层'
}

const STATUS_CLASS: Record<KernelGapItem['status'], string> = {
  covered: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  partial: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  'kernel-only': 'bg-rose-500/15 text-rose-300 border-rose-500/30'
}

const LAYER_TEXT: Record<KernelGapItem['layer'], string> = { js: 'JS 注入', network: '网络层', kernel: '内核层' }

const VERDICT_TEXT: Record<KernelGapReport['verdict'], { label: string; cls: string }> = {
  'js-only': { label: '仅 JS 层保护', cls: 'text-emerald-300' },
  'partially-hardened': { label: '部分加固', cls: 'text-amber-300' },
  'kernel-hardened': { label: '已内核级加固', cls: 'text-emerald-300' }
}

export default function KernelView(): React.JSX.Element {
  const { report, loading, busy, error, notice, load, useBranded, clearOverride, setPreferBranded } = useKernel()

  useEffect(() => {
    void load()
  }, [load])

  const identity = report?.identity ?? null

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <h2 className="text-sm font-semibold">内核能力与剩余风险</h2>
        <span className="text-xs text-slate-500">
          JS 注入改不了内核自己的行为；这里量化「还剩多少只能靠内核层解决」
        </span>
        <button onClick={() => void load()} className="ml-auto  btn btn-secondary px-3 py-1.5 text-sm">
          刷新
        </button>
      </header>

      {notice && (
        <div className="mx-5 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2 text-sm text-rose-200">{error}</div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
        {loading && !report && <div className="text-sm text-slate-500">读取内核信息…</div>}

        {identity && (
          <section className="card p-4">
            <div className="flex flex-wrap items-start gap-6">
              <div>
                <div className="text-xs text-slate-500">当前内核</div>
                <div className={`text-lg font-semibold ${identity.patched ? 'text-emerald-300' : identity.branded ? 'text-slate-100' : 'text-amber-300'}`}>
                  {FLAVOR_TEXT[identity.flavor]}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  版本 {identity.version}
                  {identity.major ? ` · 主版本 ${identity.major}` : ''} · 来源：{SOURCE_TEXT[identity.source]}
                </div>
                <div className="font-mono text-[11px] text-slate-600 mt-1 break-all max-w-2xl">{identity.path || '（未找到）'}</div>
                {identity.marker && <div className="font-mono text-[11px] text-emerald-400 mt-1">{identity.marker}</div>}
              </div>
              <div className="ml-auto text-right">
                <div className="text-xs text-slate-500">JS / 网络层覆盖率</div>
                <div className="text-3xl font-semibold tabular-nums text-slate-100">{report?.coverage}</div>
                <div className={`text-sm ${report ? VERDICT_TEXT[report.verdict].cls : ''}`}>
                  {report ? VERDICT_TEXT[report.verdict].label : ''}
                </div>
                <div className="text-[11px] text-slate-500 mt-1">
                  已覆盖 {report?.covered} · 部分 {report?.partial} · 仅内核层 {report?.kernelOnly}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => void useBranded()}
                disabled={busy || !report?.brandedAvailable}
                title={report?.brandedAvailable ?? '本机没有 /Applications/Google Chrome.app'}
                className="btn btn-primary px-3 py-1.5 text-sm disabled:opacity-40"
              >
                切到本机正式版 Chrome
              </button>
              <button
                onClick={() => void clearOverride()}
                disabled={busy}
                className=" btn btn-secondary px-3 py-1.5 text-sm disabled:opacity-40"
              >
                清除自定义内核路径
              </button>
              <label className="flex items-center gap-2 text-sm text-slate-300 ml-2">
                <input
                  type="checkbox"
                  checked={Boolean(report?.preferBranded)}
                  disabled={busy}
                  onChange={(e) => void setPreferBranded(e.target.checked)}
                />
                自动优先正式版 Chrome
              </label>
            </div>
            {report?.brandedAvailable && (
              <div className="mt-2 text-[11px] text-slate-500 font-mono break-all">
                可用正式版：{report.brandedAvailable}
              </div>
            )}
          </section>
        )}

        {report && (
          <section className="card p-4">
            <h3 className="text-xs font-semibold text-slate-300">结论</h3>
            <p className="mt-1 text-sm text-slate-300 leading-relaxed">{report.advice}</p>
          </section>
        )}

        {report && report.exploitable.length > 0 && (
          <section className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-4">
            <h3 className="text-xs font-semibold text-rose-300">
              服务端可复核、且当前未覆盖（{report.exploitable.length} 项）
            </h3>
            <p className="mt-1 text-[11px] text-slate-400">
              这些是对方能自己验证、而我们只能观测不能修改的向量 —— 真正会被打穿的口子。
            </p>
            <div className="mt-2 space-y-2">
              {report.exploitable.map((g) => (
                <div key={g.key} className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-200">{g.label}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[g.status]}`}>
                      {STATUS_TEXT[g.status]}
                    </span>
                    <span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-[10px] text-slate-300">{LAYER_TEXT[g.layer]}</span>
                    {g.usedBy.map((u) => (
                      <span key={u} className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
                        {u === 'google' ? 'Google' : 'X'}
                      </span>
                    ))}
                  </div>
                  <div className="mt-0.5 text-slate-400 leading-relaxed">{g.detail}</div>
                  {g.action && <div className="mt-0.5 text-emerald-300/90">→ {g.action}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        {report && (
          <section className="card">
            <h3 className="section-header text-xs font-semibold text-slate-300">全部向量</h3>
            <table className="w-full border-collapse text-sm">
              <thead className="text-slate-400 text-xs">
                <tr className="text-left">
                  <th className="px-4 py-1.5">向量</th>
                  <th className="py-1.5">层次</th>
                  <th className="py-1.5">服务端可复核</th>
                  <th className="py-1.5 text-right">状态</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((g) => (
                  <tr key={g.key} className="border-t border-slate-800/70 align-top">
                    <td className="px-4 py-2">
                      <div>{g.label}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{g.detail}</div>
                      {g.action && <div className="text-[11px] text-emerald-300/80 mt-0.5">→ {g.action}</div>}
                    </td>
                    <td className="py-2 text-xs text-slate-400">{LAYER_TEXT[g.layer]}</td>
                    <td className="py-2 text-xs text-slate-400">{g.serverVerifiable ? '是' : '否'}</td>
                    <td className="py-2 text-right">
                      <span className={`inline-block rounded border px-2 py-0.5 text-[11px] ${STATUS_CLASS[g.status]}`}>
                        {STATUS_TEXT[g.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  )
}