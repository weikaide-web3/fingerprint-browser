import { useEffect, useState } from 'react'
import { useProxies, useApp } from '../store'
import ProxyDialog from './ProxyDialog'
import BindProxyDialog from './BindProxyDialog'
import ImportDialog from './ImportDialog'
import Pagination from './Pagination'
import type { ProxyRecord } from '@shared/types'

function checkState(p: ProxyRecord): { label: string; cls: string } {
  if (p.lastCheckedAt === null) return { label: '未检测', cls: 'bg-slate-700/60 text-slate-300' }
  if (p.checkedOk === 1) return { label: '可用', cls: 'bg-emerald-500/20 text-emerald-300' }
  return { label: '不可用', cls: 'bg-rose-500/20 text-rose-300' }
}

/**
 * 出口质量展示。
 * 机房 / 匿名代理出口在 Google 与 X 上是一票否决，所以这一列必须比「可用/不可用」
 * 更显眼 —— 能连通但质量差的代理，登账号必死。
 */
const QUALITY_META: Record<string, { label: string; cls: string }> = {
  residential: { label: '住宅', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  mobile: { label: '蜂窝', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  datacenter: { label: '机房', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
  anonymizer: { label: '匿名代理', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
  unknown: { label: '未知', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' }
}

function qualityCell(p: ProxyRecord): React.JSX.Element {
  if (!p.quality) return <span className="text-slate-600">未检测</span>
  const meta = QUALITY_META[p.quality] ?? QUALITY_META.unknown
  const title = p.qualityIssues.length ? p.qualityIssues.join('\n') : '未发现出口质量问题'
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span className={`rounded border px-2 py-0.5 text-xs ${meta.cls}`}>{meta.label}</span>
      {p.qualityScore !== null && (
        <span className={`text-xs tabular-nums ${p.qualityScore >= 80 ? 'text-emerald-300' : p.qualityScore >= 50 ? 'text-amber-300' : 'text-rose-300'}`}>
          {p.qualityScore}
        </span>
      )}
      {p.qualityIssues.length > 0 && <span className="text-xs text-amber-300">⚠ {p.qualityIssues.length}</span>}
    </span>
  )
}

function location(p: ProxyRecord): string {
  if (!p.ip) return '—'
  const place = [p.country, p.region, p.city].filter(Boolean).join(' / ')
  return place ? `${p.ip} · ${place}` : p.ip
}

export function proxyAddress(p: ProxyRecord): string {
  return `${p.scheme}://${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`
}

export default function ProxiesView(): React.JSX.Element {
  const { proxies, usage, loading, error, checking, load, remove, check, checkAll } = useProxies()
  const { load: loadProfiles } = useApp()
  const [editing, setEditing] = useState<ProxyRecord | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [binding, setBinding] = useState<ProxyRecord | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  useEffect(() => {
    void load()
    void loadProfiles()
  }, [load, loadProfiles])

  const total = proxies.length
  const pagedProxies = proxies.slice((page - 1) * pageSize, page * pageSize)

  const toggle = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const allSelected = pagedProxies.length > 0 && pagedProxies.every((p) => selected.includes(p.id))
  const toggleSelectAll = (): void =>
    setSelected(allSelected ? [] : [...new Set([...selected, ...pagedProxies.map((p) => p.id)])])

  const batchDelete = async (): Promise<void> => {
    if (!confirm(`确认删除 ${selected.length} 个代理？绑定的环境将改回直连。`)) return
    for (const id of selected) await remove(id)
    setSelected([])
  }

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <button
          onClick={() => setCreating(true)}
          className="btn btn-primary"
        >
          <span className="text-base leading-none">+</span> 新增代理
        </button>
        <button
          onClick={() => setImporting(true)}
          className="btn btn-secondary"
        >
          批量导入
        </button>
        <button
          onClick={() => void checkAll(selected.length ? selected : undefined)}
          disabled={checking.length > 0 || proxies.length === 0}
          className="btn btn-secondary"
        >
          {checking.length > 0 ? `检测中 ${checking.length}…` : '检测全部'}
        </button>
        {selected.length > 0 && <span className="text-xs text-slate-400">已选 {selected.length}</span>}
        {selected.length > 0 && (
          <button onClick={() => void batchDelete()} className="btn btn-sm btn-danger animate-fade-in">🗑 批量删除</button>
        )}
        <button
          onClick={() => void load()}
          className="ml-auto btn btn-sm btn-ghost"
        >
          刷新
        </button>
      </header>

      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-4 py-2.5 text-sm text-rose-200 animate-fade-in">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th className="w-10"><input type="checkbox" checked={allSelected} onChange={toggleSelectAll} title="全选" /></th>
                <th>名称</th>
                <th>协议 / 地址</th>
                <th>状态</th>
                <th>出口质量</th>
                <th>出口 IP / 归属地</th>
                <th>ASN / 运营商</th>
                <th>时区</th>
                <th>延迟</th>
                <th>绑定环境</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedProxies.map((p) => (
                <ProxyRow
                  key={p.id}
                  proxy={p}
                  bound={usage[p.id] ?? 0}
                  checked={selected.includes(p.id)}
                  checking={checking.includes(p.id)}
                  onToggle={() => toggle(p.id)}
                  onCheck={() => void check(p.id)}
                  onBind={() => setBinding(p)}
                  onEdit={() => setEditing(p)}
                  onRemove={() => {
                    const extra = (usage[p.id] ?? 0) > 0 ? `，${usage[p.id]} 个环境将改回直连` : ''
                    if (confirm(`删除代理「${p.name}」？${extra}`)) void remove(p.id)
                  }}
                />
              ))}
              {proxies.length === 0 && (
                <tr><td colSpan={11}>
                  <div className="empty-state">
                    <div className="empty-state-icon">🔀</div>
                    <div className="text-sm">{loading ? '加载中…' : '还没有代理'}</div>
                    {!loading && <div className="text-xs mt-1">点击「新增代理」或「批量导入」添加你的代理</div>}
                  </div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} />
      </div>

      {creating && <ProxyDialog onClose={() => setCreating(false)} />}
      {editing && <ProxyDialog editing={editing} onClose={() => setEditing(null)} />}
      {binding && <BindProxyDialog proxy={binding} onClose={() => setBinding(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  )
}

interface RowProps {
  proxy: ProxyRecord
  bound: number
  checked: boolean
  checking: boolean
  onToggle(): void
  onCheck(): void
  onBind(): void
  onEdit(): void
  onRemove(): void
}

function ProxyRow({ proxy, bound, checked, checking, onToggle, onCheck, onBind, onEdit, onRemove }: RowProps): React.JSX.Element {
  const st = checkState(proxy)
  return (
    <tr className="animate-fade-in">
      <td>
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </td>
      <td>
        <div className="font-medium text-slate-100">{proxy.name}</div>
        {proxy.username && <div className="text-[11px] text-slate-500">账号 {proxy.username}（走本机 relay）</div>}
      </td>
      <td className="text-xs text-slate-400 whitespace-nowrap font-mono">{proxyAddress(proxy)}</td>
      <td>
        <span className={`badge ${st.cls}`}>{checking ? '检测中…' : st.label}</span>
      </td>
      <td className="whitespace-nowrap">{qualityCell(proxy)}</td>
      <td className="text-xs text-slate-400">{location(proxy)}</td>
      <td className="text-xs text-slate-400 whitespace-nowrap">
        {proxy.asn ?? '—'}
        {proxy.asName && <span className="text-slate-500"> {proxy.asName}</span>}
        {proxy.isp && !proxy.asName && <span className="text-slate-500"> {proxy.isp}</span>}
      </td>
      <td className="text-xs text-slate-400 whitespace-nowrap">{proxy.timezone ?? '—'}</td>
      <td className="text-xs text-slate-400 whitespace-nowrap">
        {proxy.latencyMs === null ? '—' : <span className={proxy.latencyMs < 200 ? 'text-emerald-300' : proxy.latencyMs < 500 ? 'text-amber-300' : 'text-rose-300'}>{proxy.latencyMs}ms</span>}
      </td>
      <td className="text-xs text-slate-400 whitespace-nowrap">{bound > 0 ? `${bound} 个` : <span className="text-slate-600">未绑定</span>}</td>
      <td className="text-right">
        <div className="inline-flex items-center gap-1">
          <button onClick={onCheck} disabled={checking} className="btn btn-xs btn-ghost text-emerald-300 hover:text-emerald-200">检测</button>
          <button onClick={onBind} className="btn btn-xs btn-ghost">绑定</button>
          <button onClick={onEdit} className="btn btn-xs btn-ghost">编辑</button>
          <button onClick={onRemove} className="btn btn-xs btn-ghost text-rose-400 hover:text-rose-300">删除</button>
        </div>
      </td>
    </tr>
  )
}
