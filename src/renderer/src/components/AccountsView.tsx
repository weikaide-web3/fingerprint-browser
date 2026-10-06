import { useEffect, useState } from 'react'
import { useAccounts, useApp } from '../store'
import { formatTime } from '../lib/format'
import { ACCOUNT_PLATFORMS, AUTOFILL_PRESETS } from '@shared/account'
import type { AccountInput, AccountPlatform, AccountRecord, AutofillPlan, TotpCodeView } from '@shared/account'

const field = 'input'

const TOTP_LABEL: Record<string, string> = {
  none: '无 2FA',
  totp: 'TOTP（可自动）',
  sms: '短信（需人工）'
}

const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(
  ACCOUNT_PLATFORMS.map((p) => [p, AUTOFILL_PRESETS[p]?.label ?? p])
)

const EMPTY: AccountInput = { platform: 'google', username: '', password: '', totpSecret: '', email: '', phone: '', note: '' }

export default function AccountsView(): React.JSX.Element {
  const { profiles, load: loadProfiles } = useApp()
  const {
    items,
    counts,
    conflicts,
    loading,
    busy,
    error,
    notice,
    code,
    plan,
    load,
    create,
    update,
    remove,
    showCode,
    showPlan,
    clearNotices
  } = useAccounts()
  const [editing, setEditing] = useState<AccountInput | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void load()
    void loadProfiles()
  }, [load, loadProfiles])

  const message = notice ?? error
  const profileName = (id: string | null): string => (id ? (profiles.find((p) => p.id === id)?.name ?? '（环境已删除）') : '未绑定')

  const visible = items.filter(
    (a) =>
      !filter ||
      a.username.toLowerCase().includes(filter.toLowerCase()) ||
      a.platform.includes(filter.toLowerCase()) ||
      (a.email ?? '').toLowerCase().includes(filter.toLowerCase())
  )

  const startCreate = (): void => {
    setEditingId(null)
    setEditing({ ...EMPTY })
  }

  const startEdit = (id: string): void => {
    const a = items.find((x) => x.id === id)
    if (!a) return
    setEditingId(id)
    // 机密不回显：留空表示保持原值（仓储层「undefined = 保持」的约定）
    setEditing({
      profileId: a.profileId,
      platform: a.platform,
      username: a.username,
      email: a.email ?? '',
      phone: a.phone ?? '',
      note: a.note ?? '',
      password: '',
      totpSecret: ''
    })
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    const payload: AccountInput = {
      ...editing,
      password: editing.password || undefined,
      totpSecret: editing.totpSecret || undefined
    }
    const ok = editingId ? await update(editingId, payload) : await create(payload)
    if (ok) setEditing(null)
  }

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <h2 className="text-sm font-semibold">账号保管</h2>
        <input
          className={`${field} w-56`}
          placeholder="搜索用户名 / 邮箱 / 平台"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-xs text-slate-500">{items.length} 个账号 · 密码与 2FA 密钥加密存储，不进入渲染进程</span>
        <button onClick={startCreate} className="ml-auto btn btn-primary px-3 py-1.5 text-sm font-medium">
          添加账号
        </button>
      </header>

      {conflicts.length > 0 && (
        <div className="mx-5 mt-3 rounded-md bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-sm text-amber-200">
          <div className="font-medium">同一账号绑定到多个环境（{conflicts.length} 组）</div>
          <div className="text-xs mt-1 leading-relaxed">
            {conflicts
              .slice(0, 3)
              .map((c) => `${c.username} @ ${c.platform} → ${c.profileIds.length} 个环境`)
              .join('；')}
            {conflicts.length > 3 && ' 等'}
            。Google / X 会看到「同一账号在多台设备出现」，这是最常见的连坐原因。
          </div>
        </div>
      )}

      {message && (
        <div
          className={`mx-5 mt-3 rounded-md border px-3 py-2 text-sm ${
            error ? 'bg-rose-500/15 border-rose-500/30 text-rose-200' : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200'
          }`}
        >
          {message}
        </div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4">
        {editing && (
          <Editor
            value={editing}
            editingId={editingId}
            busy={busy === 'create' || busy === editingId}
            profiles={profiles.map((p) => ({ id: p.id, name: p.name, accounts: counts[p.id] ?? 0 }))}
            onChange={setEditing}
            onSave={() => void save()}
            onCancel={() => setEditing(null)}
          />
        )}
        {code && <CodeBanner code={code} onClose={clearNotices} />}
        {plan && <PlanBanner plan={plan} onClose={clearNotices} />}
        <AccountTable
          items={visible}
          busy={busy}
          profileName={profileName}
          onEdit={startEdit}
          onCode={(id) => void showCode(id)}
          onPlan={(id) => void showPlan(id, true)}
          onRemove={(id) => {
            const a = items.find((x) => x.id === id)
            if (confirm(`删除账号 ${a?.username ?? id}？`)) void remove(id)
          }}
        />
        {loading && !items.length && <div className="text-sm text-slate-500 mt-3">加载账号…</div>}
        {!loading && !items.length && (
          <div className="mt-3 card p-5 text-sm text-slate-400 leading-relaxed">
            还没有账号记录。添加账号后可：
            <br />· 一键生成 TOTP 验证码（密钥只留在主进程）
            <br />· 为 Google / X 等站点生成登录页填充计划
            <br />· 检查「同一账号绑到多个环境」的连坐风险
          </div>
        )}
      </div>
    </>
  )
}

function Editor({
  value,
  editingId,
  busy,
  profiles,
  onChange,
  onSave,
  onCancel
}: {
  value: AccountInput
  editingId: string | null
  busy: boolean
  profiles: { id: string; name: string; accounts: number }[]
  onChange(v: AccountInput): void
  onSave(): void
  onCancel(): void
}): React.JSX.Element {
  const set = (patch: Partial<AccountInput>): void => onChange({ ...value, ...patch })
  return (
    <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-4 grid grid-cols-2 gap-3">
      <div className="col-span-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{editingId ? '编辑账号' : '添加账号'}</h3>
        <button onClick={onCancel} className="ml-auto text-xs text-slate-400 hover:text-slate-200">
          取消
        </button>
      </div>
      <label className="text-xs text-slate-400">
        平台
        <select className={`${field} w-full mt-1`} value={value.platform} onChange={(e) => set({ platform: e.target.value as AccountPlatform })}>
          {ACCOUNT_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {AUTOFILL_PRESETS[p]?.label ?? p}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-slate-400">
        用户名 / 账号
        <input className={`${field} w-full mt-1`} value={value.username} onChange={(e) => set({ username: e.target.value })} />
      </label>
      <label className="text-xs text-slate-400">
        密码{editingId ? '（留空保持原值）' : ''}
        <input
          type="password"
          className={`${field} w-full mt-1`}
          value={value.password ?? ''}
          placeholder={editingId ? '••••••••' : ''}
          onChange={(e) => set({ password: e.target.value })}
        />
      </label>
      <label className="text-xs text-slate-400">
        TOTP 密钥（Base32 或 otpauth:// 链接）
        <input
          className={`${field} w-full mt-1 font-mono text-xs`}
          value={value.totpSecret ?? ''}
          placeholder="JBSWY3DPEHPK3PXP 或 otpauth://totp/..."
          onChange={(e) => set({ totpSecret: e.target.value })}
        />
      </label>
      <label className="text-xs text-slate-400">
        邮箱
        <input className={`${field} w-full mt-1`} value={value.email ?? ''} onChange={(e) => set({ email: e.target.value })} />
      </label>
      <label className="text-xs text-slate-400">
        手机（短信验证无法自动，仅记录）
        <input className={`${field} w-full mt-1`} value={value.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
      </label>
      <label className="col-span-2 text-xs text-slate-400">
        绑定环境（账号 ↔ 环境建议一一对应）
        <select className={`${field} w-full mt-1`} value={value.profileId ?? ''} onChange={(e) => set({ profileId: e.target.value || null })}>
          <option value="">不绑定</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.accounts ? `（已绑 ${p.accounts} 个账号）` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="col-span-2 text-xs text-slate-400">
        备注
        <input className={`${field} w-full mt-1`} value={value.note ?? ''} onChange={(e) => set({ note: e.target.value })} />
      </label>
      <div className="col-span-2">
        <button onClick={onSave} disabled={busy} className="btn btn-primary px-3 py-1.5 text-sm disabled:opacity-40">
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

function CodeBanner({ code, onClose }: { code: TotpCodeView; onClose(): void }): React.JSX.Element {
  return (
    <div className="mb-4 flex items-center gap-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
      <div className="text-3xl font-mono tracking-widest text-emerald-200">{code.code}</div>
      <div className="text-xs text-emerald-200/80">
        {code.digits} 位 · 每 {code.periodSeconds} 秒刷新 · 剩余 {code.remainingSeconds}s
        <br />
        {formatTime(code.generatedAt)}
      </div>
      <button
        onClick={() => void navigator.clipboard.writeText(code.code)}
        className="ml-auto text-xs text-emerald-200 hover:text-emerald-100"
      >
        复制
      </button>
      <button onClick={onClose} className="text-xs text-emerald-200/70 hover:text-emerald-100">
        关闭
      </button>
    </div>
  )
}

function PlanBanner({ plan, onClose }: { plan: AutofillPlan; onClose(): void }): React.JSX.Element {
  return (
    <div className="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
      <div className="flex items-center gap-2">
        <span className="font-medium">填充计划 · {plan.username}</span>
        <span className="text-xs text-sky-200/70">{plan.loginUrl ?? '（该站点没有预设登录地址）'}</span>
        <button onClick={onClose} className="ml-auto text-xs text-sky-200/70 hover:text-sky-100">
          关闭
        </button>
      </div>
      <ol className="mt-2 space-y-1 text-xs leading-relaxed">
        {plan.steps.map((s, i) => (
          <li key={i} className="font-mono">
            {i + 1}. {s.purpose} → {s.selector}
            {s.value !== null ? ` = ${s.value}` : '（仅点击）'}
          </li>
        ))}
      </ol>
      {plan.successSelector && (
        <div className="mt-1 text-xs text-sky-200/70">登录成功判据：{plan.successSelector}</div>
      )}
      {plan.warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-200">
          {plan.warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 text-[11px] text-sky-200/60">
        计划里不含密码与验证码；机密只在执行瞬间进入内存，不写进流程、不进日志。
      </div>
    </div>
  )
}

function AccountTable({
  items,
  busy,
  profileName,
  onEdit,
  onCode,
  onPlan,
  onRemove
}: {
  items: AccountRecord[]
  busy: string | null
  profileName(id: string | null): string
  onEdit(id: string): void
  onCode(id: string): void
  onPlan(id: string): void
  onRemove(id: string): void
}): React.JSX.Element {
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="text-slate-400 text-xs">
        <tr className="text-left">
          <th className="py-1.5">平台</th>
          <th className="py-1.5">用户名</th>
          <th className="py-1.5">绑定环境</th>
          <th className="py-1.5">2FA</th>
          <th className="py-1.5">凭据</th>
          <th className="py-1.5">最近使用</th>
          <th className="py-1.5 text-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id} className="border-t border-slate-800/70 align-top">
            <td className="py-1.5 pr-3 text-slate-300">{PLATFORM_LABEL[a.platform] ?? a.platform}</td>
            <td className="py-1.5 pr-3">
              <div>{a.username}</div>
              {a.email && <div className="text-[11px] text-slate-500">{a.email}</div>}
              {a.note && <div className="text-[11px] text-slate-500">{a.note}</div>}
            </td>
            <td className="py-1.5 pr-3 text-xs text-slate-400">{profileName(a.profileId)}</td>
            <td className="py-1.5 pr-3 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 ${
                  a.totpKind === 'totp'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : a.totpKind === 'sms'
                      ? 'bg-amber-500/15 text-amber-300'
                      : 'bg-slate-700/50 text-slate-400'
                }`}
              >
                {TOTP_LABEL[a.totpKind] ?? a.totpKind}
              </span>
            </td>
            <td className="py-1.5 pr-3 text-xs text-slate-400">
              {a.hasPassword ? '密码 ✓' : '无密码'}
              {a.hasTotp ? ' · 密钥 ✓' : ''}
            </td>
            <td className="py-1.5 pr-3 text-xs text-slate-500">{a.lastUsedAt ? formatTime(a.lastUsedAt) : '未使用'}</td>
            <td className="py-1.5 text-right whitespace-nowrap">
              <button
                onClick={() => onCode(a.id)}
                disabled={!a.hasTotp || busy === a.id}
                className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs disabled:opacity-30"
              >
                验证码
              </button>
              <button
                onClick={() => onPlan(a.id)}
                disabled={busy === a.id}
                className="ml-1 rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs disabled:opacity-30"
              >
                填充计划
              </button>
              <button
                onClick={() => onEdit(a.id)}
                disabled={busy === a.id}
                className="ml-1 rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs disabled:opacity-30"
              >
                编辑
              </button>
              <button
                onClick={() => onRemove(a.id)}
                disabled={busy === a.id}
                className="ml-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 px-2 py-1 text-xs disabled:opacity-30"
              >
                删除
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}