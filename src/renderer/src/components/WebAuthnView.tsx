import { useEffect, useState } from 'react'
import { useApp, useWebAuthn } from '../store'

const field = 'input'

/**
 * Passkey / WebAuthn 管理页。
 *
 * 为什么必须有这一页：Google 与 X 现在对新设备优先推 passkey。
 * 环境里没有可注册的认证器，新设备登录就会被降级到手机/邮箱验证 ——
 * 而「需要手机验证」本身就是风控信号。
 *
 * 关键约束（实测得到，界面必须如实反映）：
 * - 一个环境只能有一个 internal（平台）虚拟认证器；
 * - 认证器按创建它的 CDP 会话作用域生效，所以注册必须在环境运行时做；
 * - 私钥必须落库并在下次启动重新注入，否则同一环境每次都被认成「没有 passkey」。
 */
export default function WebAuthnView(): React.JSX.Element {
  const { profiles, load: loadProfiles } = useApp()
  const { profileId, status, credentials, issues, busy, error, notice, select, load, enroll, verify, remove } = useWebAuthn()
  const [rpId, setRpId] = useState('accounts.google.com')
  const [userName, setUserName] = useState('')

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    if (!profileId && profiles.length) select(profiles[0].id)
  }, [profiles, profileId, select])

  useEffect(() => {
    if (profileId) void load()
  }, [profileId, load])

  const running = status?.attached ?? false

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <h2 className="text-sm font-semibold">Passkey / WebAuthn</h2>
        <span className="text-xs text-slate-500">虚拟认证器 + 凭证持久化：保证同一环境下次登录仍是同一把 passkey</span>
        <select value={profileId} onChange={(e) => select(e.target.value)} className={`${field} ml-auto w-56`}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button onClick={() => void load()} className="btn btn-secondary px-3 py-1.5 text-sm">
          刷新
        </button>
      </header>

      {notice && (
        <div className="mx-5 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-4 py-2.5 text-sm text-emerald-200 animate-fade-in">
          {notice}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-4 py-2.5 text-sm text-rose-200 animate-fade-in">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
        <section className="card p-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className={running ? 'text-emerald-300' : 'text-slate-400'}>
              {running ? '● 认证器已挂载' : '○ 未挂载（环境未运行）'}
            </span>
            <span className="text-slate-400">库中凭证 {status?.credentials ?? 0}</span>
            <span className="text-slate-400">已注入 {status?.attachedCredentials ?? 0}</span>
            {status?.configured && (
              <span className="text-slate-400">
                声明认证器：{status.configured.model} · AAGUID {status.configured.aaguid}
              </span>
            )}
          </div>

          {status && status.attached && status.credentials !== status.attachedCredentials && (
            <div className="mt-2 text-xs text-amber-300/80">
              库里有 {status.credentials} 个凭证，但当前认证器里只有 {status.attachedCredentials} 个 —— 说明有凭证重新注入失败，
              这些 passkey 在本次会话里用不了。
            </div>
          )}

          {issues.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-amber-300/80">
              {issues.map((i, idx) => (
                <li key={idx}>· {i}</li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input className={`${field} w-64`} value={rpId} onChange={(e) => setRpId(e.target.value)} placeholder="rpId，如 accounts.google.com" />
            <input className={`${field} w-56`} value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="用户名（可选）" />
            <button
              onClick={() => void enroll({ rpId, userName: userName || undefined })}
              disabled={busy || !profileId}
              className="btn btn-primary px-3 py-1.5 text-sm"
              title="注册会在该环境的真实内核里打开站点页面，需要环境能访问该域名"
            >
              {busy ? '注册中…' : '注册 passkey'}
            </button>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            注册会拉起该环境的内核并访问 https://&lt;rpId&gt;/，由内核真实生成密钥对。私钥加密落库，下次打开环境自动重新注入。
          </div>
        </section>

        <section className="card">
          <h3 className="section-header text-xs font-semibold text-slate-300">已保存的 passkey</h3>
          {credentials.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-slate-500">该环境还没有 passkey。注册一个后，新设备登录就不会被降级到手机验证。</div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-[11px] text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">站点</th>
                  <th className="px-4 py-2 text-left font-medium">用户</th>
                  <th className="px-4 py-2 text-left font-medium">credentialId</th>
                  <th className="px-4 py-2 text-left font-medium">signCount</th>
                  <th className="px-4 py-2 text-left font-medium">状态</th>
                  <th className="px-4 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => (
                  <tr key={c.id} className="border-t border-slate-800/70">
                    <td className="px-4 py-2">{c.rpId}</td>
                    <td className="px-4 py-2 text-slate-400">{c.userName ?? '—'}</td>
                    <td className="px-4 py-2 font-mono text-[11px] text-slate-500">{c.credentialId.slice(0, 16)}…</td>
                    <td className="px-4 py-2 text-slate-400">{c.signCount}</td>
                    <td className="px-4 py-2">
                      {c.hasPrivateKey ? (
                        <span className="text-emerald-300 text-xs">可用</span>
                      ) : (
                        <span className="text-rose-300 text-xs">私钥不可解密，需重新注册</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right space-x-2 whitespace-nowrap">
                      <button
                        onClick={() => void verify(c.credentialId)}
                        disabled={busy || !c.hasPrivateKey}
                        className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40"
                        title="用这把 passkey 做一次断言，验证该设备真的能登录"
                      >
                        验证
                      </button>
                      <button onClick={() => void remove(c.id)} className="text-xs text-rose-400/80 hover:text-rose-300">
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="px-4 py-3 text-[11px] text-slate-500 border-t border-slate-800/70">
            signCount 每次断言都会递增；服务端看到它倒退说明凭证被复制到了别的设备。
          </div>
        </section>
      </div>
    </>
  )
}
