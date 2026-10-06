import { useState } from 'react'
import { useApp, useProxies } from '../store'
import { proxyAddress } from './ProxiesView'
import type { ProxyRecord } from '@shared/types'

interface Props {
  proxy: ProxyRecord
  onClose(): void
}

/**
 * 把代理绑定到环境 / 从环境解绑。
 * 正在运行的环境会被跳过：改启动参数对已启动的进程无效，
 * 静默改库会让用户以为浏览器已经换了出口。
 */
export default function BindProxyDialog({ proxy, onClose }: Props): React.JSX.Element {
  const { profiles, update, load } = useApp()
  const reloadProxies = useProxies((s) => s.load)
  const [picked, setPicked] = useState<string[]>(
    profiles.filter((p) => p.proxyId === proxy.id).map((p) => p.id)
  )
  const [busy, setBusy] = useState(false)

  const toggle = (id: string): void =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const apply = async (): Promise<void> => {
    setBusy(true)
    const before = new Set(profiles.filter((p) => p.proxyId === proxy.id).map((p) => p.id))
    for (const p of profiles) {
      if (p.status === 'running') continue
      const want = picked.includes(p.id)
      if (want === before.has(p.id)) continue
      // 解绑时同时把 proxyMode 置为 none，避免留下「bind 但没有代理」的半套状态
      await update(p.id, want ? { proxyId: proxy.id, proxyMode: 'bind' } : { proxyId: null, proxyMode: 'none' })
    }
    // 两个 store 都要刷新：环境列表看 proxyId，代理列表看绑定计数
    await Promise.all([load(), reloadProxies()])
    setBusy(false)
    onClose()
  }

  const running = profiles.filter((p) => p.status === 'running')
  // 机房 / 匿名代理 / 未检测出口：登 Google、X 账号基本必死，绑定时必须提醒
  const risky = proxy.quality === 'datacenter' || proxy.quality === 'anonymizer' || proxy.quality === 'unknown'
  const neverChecked = proxy.quality === null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="w-[520px] rounded-xl bg-[#0d1117] border border-slate-700 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold mb-1">绑定环境</div>
        <div className="text-xs text-slate-400 mb-4">
          {proxy.name} · {proxyAddress(proxy)}
        </div>
        {risky && (
          <div className="mb-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2 text-xs text-rose-200 leading-relaxed">
            出口质量判定为 <b>{proxy.quality === 'datacenter' ? '机房' : proxy.quality === 'anonymizer' ? '匿名代理' : '未知'}</b>
            （得分 {proxy.qualityScore ?? 0}）。Google 与 X 对这类出口基本是一票否决，指纹再好也会被判定为机器人流量。
            {proxy.qualityIssues.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-rose-200/80">
                {proxy.qualityIssues.map((i, idx) => (
                  <li key={idx}>{i}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {neverChecked && (
          <div className="mb-3 rounded-md bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-200">
            该代理还没做过出口检测，无法判断出口质量。建议先在列表里点「检测」再绑定。
          </div>
        )}
        <div className="max-h-80 overflow-auto border border-slate-800 rounded-md">
          {profiles.map((p) => (
            <label
              key={p.id}
              className={`flex items-center gap-2 px-3 py-2 text-sm border-b border-slate-800/60 ${
                p.status === 'running' ? 'opacity-50' : 'hover:bg-slate-800/40'
              }`}
            >
              <input
                type="checkbox"
                checked={picked.includes(p.id)}
                disabled={p.status === 'running'}
                onChange={() => toggle(p.id)}
              />
              <span className="font-medium">{p.name}</span>
              {p.status === 'running' && <span className="text-xs text-amber-300">运行中，需先关闭</span>}
              {p.proxyId && p.proxyId !== proxy.id && (
                <span className="ml-auto text-xs text-slate-500">当前已绑其它代理</span>
              )}
            </label>
          ))}
          {profiles.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-500">还没有环境</div>}
        </div>
        {running.length > 0 && (
          <div className="mt-3 text-[11px] text-amber-300/80 leading-relaxed">
            {running.length} 个环境正在运行，本次不会改动它们（启动参数对已启动的进程无效）。
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className=" btn btn-secondary px-3 py-1.5 text-sm">
            取消
          </button>
          <button
            disabled={busy}
            onClick={() => void apply()}
            className="btn btn-primary disabled:opacity-50 px-4 py-1.5 text-sm"
          >
            {busy ? '保存中…' : '应用'}
          </button>
        </div>
      </div>
    </div>
  )
}
