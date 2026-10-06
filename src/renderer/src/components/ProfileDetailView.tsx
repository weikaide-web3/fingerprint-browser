import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../store'
import { STATUS_LABEL, STATUS_STYLE } from './ProfilesView'
import type { AssociationReport } from '@shared/association'
import type { ConsistencyIssue, ConsistencyReport, FingerprintConfig, Profile } from '@shared/types'

const ISSUE_STYLE: Record<ConsistencyIssue['level'], { label: string; cls: string }> = {
  error: { label: '严重', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/30' },
  warn: { label: '注意', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  info: { label: '提示', cls: 'bg-slate-700/50 text-slate-300 border-slate-600/40' }
}

/** 详情页要展示的指纹关键项；顺序即展示顺序 */
function summaryRows(fp: FingerprintConfig): { label: string; value: string }[] {
  return [
    { label: 'User-Agent', value: fp.ua.ua },
    { label: '浏览器 / 版本', value: `${fp.ua.browser} ${fp.ua.version}（major ${fp.ua.major}）` },
    { label: '系统 / 架构', value: `${fp.ua.os} · ${fp.hardware.platform} · ${fp.hardware.cpuArchitecture}/${fp.hardware.bitness}` },
    { label: 'Client Hints', value: fp.clientHints.enabled ? `${fp.clientHints.platform} · ${fp.clientHints.uaFullVersion}` : '关闭' },
    { label: '屏幕', value: `${fp.screen.width}×${fp.screen.height} · 可用 ${fp.screen.availWidth}×${fp.screen.availHeight} · dpr ${fp.screen.devicePixelRatio}` },
    { label: 'WebGL', value: `${fp.webgl.vendor} / ${fp.webgl.renderer}` },
    { label: 'WebGPU', value: fp.webgpu.enabled ? fp.webgpu.vendor : '关闭' },
    { label: 'Canvas / Audio', value: `${fp.canvas.mode} / ${fp.audio.mode}` },
    { label: 'WebRTC', value: `${fp.webrtc.mode}${fp.webrtc.publicIp ? ` · ${fp.webrtc.publicIp}` : ''}` },
    { label: '时区', value: `${fp.timezone.id}（UTC${fp.timezone.offsetMinutes / 60 >= 0 ? '+' : ''}${fp.timezone.offsetMinutes / 60}）` },
    { label: '语言', value: `${fp.language.acceptLanguage} · ${fp.language.intlLocale}` },
    { label: 'CPU / 内存', value: `${fp.hardware.hardwareConcurrency} 核 / ${fp.hardware.deviceMemory} GB` },
    { label: '主 seed', value: fp.seed }
  ]
}

export default function ProfileDetailView({ profileId }: { profileId: string }): React.JSX.Element {
  const { groups, load, loadGroups, closeDetail, start, stop } = useApp()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', note: '', groupId: '' })
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [report, setReport] = useState<ConsistencyReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [assoc, setAssoc] = useState<AssociationReport | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const p = await window.api.profiles.get(profileId)
      setProfile(p)
      if (p) setForm({ name: p.name, note: p.note ?? '', groupId: p.groupId ?? '' })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [profileId])

  useEffect(() => {
    void reload()
    void loadGroups()
  }, [reload, loadGroups])

  // 详情页自己也要订阅内核状态：否则在这里点「打开内核」，
  // 标题旁的状态徽标不会变，看起来像没生效。
  useEffect(() => {
    return window.api.events.onStatus((evt) => {
      if (evt.profileId !== profileId) return
      setProfile((prev) => (prev ? { ...prev, status: evt.status } : prev))
    })
  }, [profileId])

  // 关联风险必须在详情页也可见：单个环境体检满分不代表它能和别的环境共存，
  // 共用出口 / 同 seed / 同账号多环境都是「别人出卖它」的问题，只有全量比对才发现得了。
  const reloadAssoc = useCallback(async (): Promise<void> => {
    try {
      setAssoc(await window.api.association.checkProfile(profileId))
    } catch {
      // 关联检查失败不该挡住详情页主体内容，静默降级为不显示
      setAssoc(null)
    }
  }, [profileId])

  useEffect(() => {
    void reloadAssoc()
  }, [reloadAssoc])

  const dirty =
    profile !== null &&
    (form.name !== profile.name || form.note !== (profile.note ?? '') || form.groupId !== (profile.groupId ?? ''))

  const save = async (): Promise<void> => {
    const name = form.name.trim()
    if (!name) {
      setError('环境名称不能为空')
      return
    }
    setSaving(true)
    try {
      const updated = await window.api.profiles.update(profileId, {
        name,
        note: form.note,
        groupId: form.groupId || null
      })
      if (!updated) throw new Error('环境不存在')
      setProfile(updated)
      setForm({ name: updated.name, note: updated.note ?? '', groupId: updated.groupId ?? '' })
      setSavedAt(Date.now())
      setError(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const regenerate = async (): Promise<void> => {
    setRegenerating(true)
    try {
      await window.api.profiles.regenerateFingerprint(profileId)
      // 指纹换了，旧体检结果必须作废，否则界面显示的是上一份指纹的得分
      setReport(null)
      await reload()
      await load()
      // 新 seed 会改变「与其它环境是否撞指纹」的结论，关联结论要一起刷新
      await reloadAssoc()
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRegenerating(false)
    }
  }

  const runCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      setReport(await window.api.profiles.validateFingerprint(profileId))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const fp = profile?.fingerprint ?? null
  const inputCls = 'w-full rounded-md bg-slate-800/70 border border-slate-700 px-3 py-1.5 text-sm outline-none focus:border-emerald-500'
  const btnCls = 'btn btn-secondary'

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <button
          onClick={closeDetail}
          aria-label="返回环境列表"
          className=" btn btn-secondary px-3 py-1.5 text-sm"
        >
          ← 返回列表
        </button>
        <h2 className="text-base font-semibold truncate">{profile ? profile.name : loading ? '加载中…' : '环境不存在'}</h2>
        {profile && (
          <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[profile.status]}`}>
            {STATUS_LABEL[profile.status]}
          </span>
        )}
        {dirty && <span className="text-xs text-amber-300">未保存</span>}
        {savedAt !== null && !dirty && (
          <span className="text-xs text-emerald-300">已保存 {new Date(savedAt).toLocaleTimeString()}</span>
        )}
        <div className="ml-auto">
          {profile?.status === 'running' ? (
            <button
              onClick={() => void stop(profileId)}
              className="rounded-md bg-amber-600/80 hover:bg-amber-500 px-3 py-1.5 text-sm"
            >
              停止内核
            </button>
          ) : (
            <button
              onClick={() => void start(profileId)}
              className="btn btn-primary px-3 py-1.5 text-sm"
            >
              打开内核
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4 grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <section className="card p-4">
          <div className="text-xs font-semibold text-slate-300">基本信息</div>

          <label className="mt-3 block text-xs text-slate-400">环境名称</label>
          <input
            aria-label="环境名称"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`mt-1 ${inputCls}`}
          />

          <label className="mt-3 block text-xs text-slate-400">分组</label>
          <select
            aria-label="环境分组"
            value={form.groupId}
            onChange={(e) => setForm({ ...form, groupId: e.target.value })}
            className={`mt-1 ${inputCls}`}
          >
            <option value="">未分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>

          <label className="mt-3 block text-xs text-slate-400">备注</label>
          <textarea
            aria-label="环境备注"
            rows={4}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            className={`mt-1 ${inputCls}`}
          />

          <div className="mt-3 flex items-center gap-3">
            <button
              aria-label="保存环境信息"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="btn btn-primary disabled:opacity-50 px-3 py-1.5 text-sm font-medium"
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <span className="text-xs text-slate-500">
              创建 {profile ? new Date(profile.createdAt).toLocaleString() : '—'} · 已打开 {profile?.openCount ?? 0} 次
            </span>
          </div>

          {profile && profile.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {profile.tags.map((t) => (
                <span key={t} className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="card p-4">
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold text-slate-300">指纹摘要</div>
            {fp && (
              <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
                {fp.kernel} · mode {fp.mode}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <button aria-label="一致性体检" onClick={() => void runCheck()} disabled={checking || !fp} className={btnCls}>
                {checking ? '体检中…' : '一致性体检'}
              </button>
              <button
                aria-label="重新生成指纹"
                onClick={() => void regenerate()}
                disabled={regenerating || !fp}
                className={btnCls}
              >
                {regenerating ? '生成中…' : '重新生成指纹'}
              </button>
            </div>
          </div>

          {fp ? (
            <dl aria-label="指纹摘要" className="mt-3 grid grid-cols-1 gap-y-1.5 text-xs">
              {summaryRows(fp).map((r) => (
                <div key={r.label} className="grid grid-cols-[110px_1fr] gap-2">
                  <dt className="text-slate-500">{r.label}</dt>
                  <dd className="text-slate-200 break-all">{r.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="mt-3 text-xs text-slate-500">该环境还没有指纹配置</div>
          )}

          <div className="mt-3 text-xs text-slate-400">
            代理：
            {profile?.proxy
              ? `${profile.proxy.scheme}://${profile.proxy.host}:${profile.proxy.port}${
                  profile.proxy.ip ? ` · 出口 ${profile.proxy.ip}` : ' · 未检测'
                }`
              : '直连'}
          </div>
        </section>

        <section className="xl:col-span-2 card p-4">
          <div className="text-xs font-semibold text-slate-300">一致性体检</div>
          {report ? (
            <>
              <div className="mt-2 flex items-center gap-3">
                <span
                  aria-label="一致性得分"
                  className={`rounded px-2 py-1 text-sm font-semibold ${
                    report.score >= 90
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : report.score >= 70
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-rose-500/20 text-rose-300'
                  }`}
                >
                  得分 {report.score}
                </span>
                <span className="text-xs text-slate-400">
                  严重 {report.errors} · 注意 {report.warns} · 提示 {report.infos}
                </span>
              </div>
              {report.issues.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {report.issues.map((i) => (
                    <li
                      key={i.code}
                      data-issue-level={i.level}
                      className={`rounded border px-3 py-2 text-xs ${ISSUE_STYLE[i.level].cls}`}
                    >
                      <span className="mr-2 rounded bg-slate-900/60 px-1.5 py-0.5 text-[10px]">
                        {ISSUE_STYLE[i.level].label}
                      </span>
                      <span className="font-mono text-[11px]">{i.code}</span>
                      <div className="mt-1 text-slate-200">{i.message}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">涉及字段：{i.fields.join(' · ')}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 text-xs text-emerald-300">没有发现矛盾，指纹自洽。</div>
              )}
            </>
          ) : (
            <div className="mt-2 text-xs text-slate-500">
              点击「一致性体检」，检查 UA / Client Hints / 屏幕 / GPU / 时区 / 代理出口之间是否互相矛盾。
            </div>
          )}
        </section>

        <section className="xl:col-span-2 card p-4">
          <div className="text-xs font-semibold text-slate-300">关联风险（与其它环境 / 代理 / 账号的关系）</div>
          {assoc ? (
            <>
              <div className="mt-2 flex items-center gap-3">
                <span
                  aria-label="关联得分"
                  className={`rounded px-2 py-1 text-sm font-semibold ${
                    assoc.score >= 85
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : assoc.score >= 60
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-rose-500/20 text-rose-300'
                  }`}
                >
                  得分 {assoc.score}
                </span>
                <span className="text-xs text-slate-400">
                  严重 {assoc.errors} · 注意 {assoc.warns} · 提示 {assoc.infos}
                </span>
              </div>
              {assoc.issues.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {assoc.issues.map((i, idx) => (
                    <li
                      key={`${i.code}-${idx}`}
                      data-issue-level={i.level}
                      className={`rounded border px-3 py-2 text-xs ${ISSUE_STYLE[i.level].cls}`}
                    >
                      <span className="mr-2 rounded bg-slate-900/60 px-1.5 py-0.5 text-[10px]">{ISSUE_STYLE[i.level].label}</span>
                      <span className="font-mono text-[11px]">{i.code}</span>
                      <div className="mt-1 text-slate-200">{i.message}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2 text-xs text-emerald-300">这个环境与其它环境 / 代理 / 账号之间没有已知关联风险。</div>
              )}
            </>
          ) : (
            <div className="mt-2 text-xs text-slate-500">正在比对「环境-代理-账号」三元组…</div>
          )}
        </section>
      </div>
    </>
  )
}


