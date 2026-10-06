import { useState } from 'react'
import { useProxies } from '../store'
import type { ProxyRecord } from '@shared/types'

const SCHEME_OPTIONS: { value: ProxyRecord['scheme']; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks5h', label: 'SOCKS5H（远端 DNS）' },
  { value: 'socks4', label: 'SOCKS4' }
]

interface Props {
  /** 传了就是编辑，不传就是新建 */
  editing?: ProxyRecord | null
  onClose(): void
}

export default function ProxyDialog({ editing, onClose }: Props): React.JSX.Element {
  const { create, update } = useProxies()
  const [name, setName] = useState(editing?.name ?? '')
  const [scheme, setScheme] = useState<ProxyRecord['scheme']>(editing?.scheme ?? 'http')
  const [host, setHost] = useState(editing?.host ?? '')
  const [port, setPort] = useState(editing ? String(editing.port) : '')
  const [username, setUsername] = useState(editing?.username ?? '')
  // 编辑时不回填密码（库里是密文），留空表示保持原密码不变
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const field =
    'w-full rounded-md bg-slate-800/70 border border-slate-700 px-3 py-1.5 text-sm outline-none focus:border-emerald-500'

  const submit = async (): Promise<void> => {
    setBusy(true)
    const payload = {
      name: name.trim(),
      scheme,
      host: host.trim(),
      port: Number(port),
      username: username.trim() || null
    }
    let ok: boolean
    if (editing) {
      ok = await update(editing.id, { ...payload, ...(password ? { password } : {}) })
    } else {
      ok = (await create({ ...payload, password: password || null })) !== null
    }
    setBusy(false)
    if (ok) onClose()
  }

  const needsRelay = Boolean(username || password)

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="w-[520px] rounded-xl bg-[#0d1117] border border-slate-700 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold mb-4">{editing ? '编辑代理' : '新增代理'}</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 text-xs text-slate-400">
            名称
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="留空则用地址自动命名" />
          </label>
          <label className="text-xs text-slate-400">
            协议
            <select className={field} value={scheme} onChange={(e) => setScheme(e.target.value as ProxyRecord['scheme'])}>
              {SCHEME_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            端口
            <input
              type="number"
              min={1}
              max={65535}
              className={field}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="1–65535"
            />
          </label>
          <label className="col-span-2 text-xs text-slate-400">
            地址
            <input
              className={field}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="例如 127.0.0.1 或 proxy.example.com，IPv6 用方括号"
            />
          </label>
          <label className="text-xs text-slate-400">
            账号
            <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="可选" />
          </label>
          <label className="text-xs text-slate-400">
            密码
            <input
              type="password"
              className={field}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={editing?.hasPassword ? '已设置，留空表示不修改' : '可选'}
            />
          </label>
        </div>
        <div className="mt-3 text-[11px] text-slate-500 leading-relaxed">
          {needsRelay ? (
            <>
              该代理需要认证。Chrome 的 --proxy-server 不接受账号密码（HTTP 会弹认证窗、SOCKS5 不支持认证），
              打开环境时会自动走本机 relay，由 relay 补上凭据，浏览器侧不会弹窗。密码用系统钥匙串加密存储。
            </>
          ) : (
            <>不带账号密码时，环境会直连该代理。密码用系统钥匙串加密存储，不会明文落盘。</>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className=" btn btn-secondary px-3 py-1.5 text-sm">
            取消
          </button>
          <button
            disabled={busy || !host.trim() || !port}
            onClick={() => void submit()}
            className="btn btn-primary disabled:opacity-50 px-4 py-1.5 text-sm"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}