import { useEffect, useMemo, useState } from 'react'
import { useSettings } from '../store'
import type { SettingGroup, SettingView } from '@shared/settings'

const field = 'input'

const GROUP_ORDER: SettingGroup[] = ['内核', '启动参数', '代理', '自动化 API', '自动化', '会话与检测', '关联隔离', '其它']

function Control({
  item,
  onCommit,
  busy
}: {
  item: SettingView
  busy: boolean
  onCommit(value: string | number | boolean | null): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string>(String(item.value ?? ''))
  // 外部值变化（保存失败回滚 / 恢复默认）要同步回输入框，否则界面和库里不一致
  useEffect(() => {
    setDraft(String(item.value ?? ''))
  }, [item.value])

  if (item.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={item.value === true} disabled={busy} onChange={(e) => onCommit(e.target.checked)} />
        <span className={item.value === true ? 'text-emerald-300' : 'text-slate-500'}>
          {item.value === true ? '已开启' : '未开启'}
        </span>
      </label>
    )
  }
  if (item.type === 'select') {
    return (
      <select className={field} value={String(item.value ?? '')} disabled={busy} onChange={(e) => onCommit(e.target.value)}>
        {(item.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  const isSecret = item.type === 'secret'
  if (isSecret) {
    // secret 的值不回传渲染进程（item.value 恒为空），所以这里做成「只写」字段：
    // 留空 = 保持原值不变，输入 = 覆盖，点「清除」= 显式置空。
    return (
      <div className="flex items-center gap-2">
        <input
          type="password"
          className={`${field} w-72`}
          value={draft}
          disabled={busy}
          placeholder={item.secretSet ? '已设置（留空保持不变）' : '留空表示不鉴权'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft) onCommit(draft)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        {item.secretSet && (
          <span className="text-xs text-emerald-300/70">已设置</span>
        )}
        {item.secretSet && (
          <button
            type="button"
            onClick={() => onCommit('')}
            className="text-xs text-slate-400 hover:text-rose-300"
          >
            清除
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type={item.type === 'number' ? 'number' : 'text'}
        className={`${field} w-72`}
        value={draft}
        disabled={busy}
        placeholder={String(item.def)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== String(item.value ?? '')) onCommit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}

export default function SettingsView(): React.JSX.Element {
  const { items, info, loading, busy, error, notice, load, set, reset } = useSettings()
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const grouped = useMemo(() => {
    const map = new Map<SettingGroup, SettingView[]>()
    for (const item of items) {
      const list = map.get(item.group) ?? []
      list.push(item)
      map.set(item.group, list)
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g) as SettingView[]] as const)
  }, [items])

  const pickKernel = async (): Promise<void> => {
    setPicking(true)
    const dir = await window.api.app.pickDirectory()
    setPicking(false)
    if (dir) await set('chromiumExecutable', dir)
  }

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <h2 className="text-sm font-semibold">设置</h2>
        <span className="text-xs text-slate-500">改动即时保存；标注「重启」的项需要重启应用或重新打开环境才生效</span>
        <button onClick={() => void load()} className="ml-auto  btn btn-secondary px-3 py-1.5 text-sm">
          刷新
        </button>
      </header>

      {notice && (
        <div className="mx-5 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-4 py-2.5 text-sm text-emerald-200 animate-fade-in">
          {notice}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-4 py-2.5 text-sm text-rose-200 animate-fade-in">{error}</div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
        {grouped.map(([group, list]) => (
          <section key={group} className="card">
            <h3 className="section-header text-xs font-semibold text-slate-300">{group}</h3>
            <div className="divide-y divide-slate-800/70">
              {list.map((item) => (
                <div key={item.key} className="flex items-start gap-4 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">
                      {item.label}
                      {item.restart && (
                        <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                          {item.restart === 'app' ? '重启应用' : '重开环境'}
                        </span>
                      )}
                      {!item.isDefault && (
                        <span className="ml-2 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-300">已自定义</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 leading-relaxed">{item.description}</div>
                    <div className="mt-1 text-[11px] text-slate-600 font-mono">{item.key}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Control item={item} busy={busy === item.key} onCommit={(v) => void set(item.key, v)} />
                    {!item.isDefault && (
                      <button
                        onClick={() => void reset(item.key)}
                        className="text-xs text-slate-400 hover:text-slate-200"
                        title={`恢复默认：${String(item.def)}`}
                      >
                        默认
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}

        {loading && !items.length && <div className="text-sm text-slate-500">加载设置…</div>}

        <section className="card">
          <h3 className="section-header text-xs font-semibold text-slate-300">关于与数据位置</h3>
          <div className="px-4 py-3 text-xs text-slate-400 space-y-1.5 leading-relaxed">
            {info ? (
              <>
                <div>版本 {info.version} · Electron {info.electron} · Chromium {info.chrome} · Node {info.node}</div>
                <div>
                  平台 {info.platform} / {info.arch}
                </div>
                <div className="font-mono text-slate-500">数据目录 {info.dataDir}</div>
                <div className="font-mono text-slate-500">环境目录 {info.profilesDir}</div>
                <div className="pt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => void window.api.app.revealPath(info.dataDir)}
                    className="btn btn-sm btn-secondary"
                  >
                    打开数据目录
                  </button>
                  <button
                    onClick={() => void window.api.app.revealPath(info.profilesDir)}
                    className="btn btn-sm btn-secondary"
                  >
                    打开环境目录
                  </button>
                  <button
                    onClick={() => void pickKernel()}
                    disabled={picking}
                    className="btn btn-sm btn-secondary"
                  >
                    选择内核所在目录…
                  </button>
                </div>
                <div className="pt-1 text-slate-500">
                  提示：「选择内核所在目录」会把目录填进「自定义内核路径」，需要该目录下存在可执行文件才生效；
                  留空则始终使用 Playwright 自带的 Chromium。
                </div>
              </>
            ) : (
              <div>读取应用信息…</div>
            )}
          </div>
        </section>
      </div>
    </>
  )
}