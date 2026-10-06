import { useEffect, useState } from 'react'
import { useApp, useProxies } from '../store'

const LOCALES = ['en-US', 'zh-CN', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'pt-BR']
const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin'
]

type ProxyAssignMode = 'none' | 'auto-unassigned' | 'bind'

interface Props {
  onClose(): void
}

export default function CreateProfileDialog({ onClose }: Props): React.JSX.Element {
  const { create, groups, loadGroups } = useApp()
  const { proxies, usage, load: loadProxies } = useProxies()
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [groupId, setGroupId] = useState('')
  const [count, setCount] = useState(1)
  const [os, setOs] = useState<'macOS' | 'Windows'>('macOS')
  const [locale, setLocale] = useState('zh-CN')
  const [timezone, setTimezone] = useState('Asia/Shanghai')
  const [urls, setUrls] = useState('')
  const [busy, setBusy] = useState(false)
  const [proxyMode, setProxyMode] = useState<ProxyAssignMode>('none')
  const [selectedProxyId, setSelectedProxyId] = useState('')

  useEffect(() => {
    void loadGroups()
    void loadProxies()
  }, [loadGroups, loadProxies])

  const unusedProxies = proxies.filter((p) => (usage[p.id] ?? 0) === 0)
  const canAutoAssign = unusedProxies.length >= count

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    const startupUrls = urls
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean)

    for (let i = 0; i < count; i++) {
      let proxyId: string | null = null
      let proxyModeForInput: 'bind' | 'none' = 'none'

      if (proxyMode === 'auto-unassigned') {
        const proxy = unusedProxies[i]
        if (proxy) {
          proxyId = proxy.id
          proxyModeForInput = 'bind'
        }
      } else if (proxyMode === 'bind' && selectedProxyId) {
        proxyId = selectedProxyId
        proxyModeForInput = 'bind'
      }

      await create({
        name: count > 1 ? `${name.trim()} ${i + 1}` : name.trim(),
        note: note || null,
        groupId: groupId || null,
        startupUrls,
        fingerprint: null,
        cloneFrom: null,
        fingerprintOptions: { os, locale, timezone },
        proxyMode: proxyModeForInput,
        proxyId
      })
    }
    setBusy(false)
    onClose()
  }

  const field = 'input w-full'

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-panel w-[560px] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="text-base font-semibold mb-5 flex items-center gap-2">
          <span className="text-lg">🌐</span> 新建环境
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 text-xs text-slate-400">环境名称
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：店铺 A - 主账号" />
          </label>
          <label className="text-xs text-slate-400">分组
            <select className={field} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">未分组</option>
              {groups.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
            </select>
          </label>
          <label className="text-xs text-slate-400">批量创建数量
            <input type="number" min={1} max={50} className={field} value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
          </label>
          <label className="text-xs text-slate-400">模拟系统
            <select className={field} value={os} onChange={(e) => setOs(e.target.value as 'macOS' | 'Windows')}>
              <option value="macOS">macOS</option>
              <option value="Windows">Windows</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">语言
            <select className={field} value={locale} onChange={(e) => setLocale(e.target.value)}>
              {LOCALES.map((l) => (<option key={l}>{l}</option>))}
            </select>
          </label>
          <label className="col-span-2 text-xs text-slate-400">时区
            <select className={field} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map((t) => (<option key={t}>{t}</option>))}
            </select>
          </label>

          <div className="col-span-2 mt-1 pt-3 border-t border-[#1e293b]">
            <div className="text-xs font-medium text-slate-300 mb-2">代理分配</div>
            <div className="flex items-center gap-3 mb-2">
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                <input type="radio" name="proxyMode" checked={proxyMode === 'none'}
                  onChange={() => setProxyMode('none')} className="accent-emerald-500" />
                直连
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                <input type="radio" name="proxyMode" checked={proxyMode === 'auto-unassigned'}
                  onChange={() => setProxyMode('auto-unassigned')} className="accent-emerald-500" />
                自动分配未使用代理
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                <input type="radio" name="proxyMode" checked={proxyMode === 'bind'}
                  onChange={() => setProxyMode('bind')} className="accent-emerald-500" />
                指定代理
              </label>
            </div>
            {proxyMode === 'auto-unassigned' && (
              <div className={`text-[11px] ${canAutoAssign ? 'text-slate-500' : 'text-amber-400'}`}>
                当前有 <span className="font-medium text-slate-300">{unusedProxies.length}</span> 个未被使用的代理
                {count > 1 && <>，将为 {count} 个环境各分配一个不同代理</>}
                {!canAutoAssign && <>（不足！仅前 {unusedProxies.length} 个环境会被绑定，其余直连）</>}
              </div>
            )}
            {proxyMode === 'bind' && (
              <select className={field} value={selectedProxyId}
                onChange={(e) => setSelectedProxyId(e.target.value)}>
                <option value="">— 选择代理 —</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.scheme}://{p.host}:{p.port}){usage[p.id] > 0 ? ` \u00b7 \u5df2\u7ed1 ${usage[p.id]}` : ' \u00b7 \u7a7a\u95f2'}
                  </option>
                ))}
              </select>
            )}
          </div>
          <label className="col-span-2 text-xs text-slate-400 mt-1">启动 URL（每行一个）
            <textarea className={field} rows={2} value={urls} onChange={(e) => setUrls(e.target.value)} />
          </label>
          <label className="col-span-2 text-xs text-slate-400">备注
            <input className={field} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed">
          指纹（UA / Client Hints / 屏幕 / 时区 / 语言 / GPU / Canvas / Audio / 字体 / 硬件）会按内核真实版本自动生成，创建后可在环境详情中逐项修改。
        </div>
        <div className="mt-5 flex justify-end gap-2 pt-4 border-t border-[#1e293b]">
          <button onClick={onClose} className="btn btn-secondary">取消</button>
          <button disabled={busy || !name.trim() || (proxyMode === 'bind' && !selectedProxyId)}
            onClick={() => void submit()} className="btn btn-primary">
            {busy ? '创建中…' : `\u2713 创建${count > 1 ? ` ${count} 个` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
