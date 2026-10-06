import { useEffect, useMemo, useState } from 'react'
import { useApp, useRpa } from '../store'
import { formatTime } from '../lib/format'
import type { RpaFlow, RpaStep, StepType } from '@shared/rpa'

const field = 'input'
const btn = 'btn btn-secondary'
const primary = 'btn btn-primary'

const TYPE_LABEL: Record<StepType, string> = {
  goto: '打开网址',
  click: '点击',
  fill: '填写',
  press: '按键',
  select: '下拉选择',
  hover: '悬停',
  wait: '等待元素',
  sleep: '固定等待',
  text: '抓取文本',
  attribute: '抓取属性',
  assertText: '断言文本',
  assertVisible: '断言可见',
  evaluate: '执行 JS',
  screenshot: '截图',
  setVariable: '设置变量',
  log: '记录日志',
  if: '条件分支',
  loop: '循环'
}

interface FieldSpec {
  key: string
  label: string
  kind: 'text' | 'number' | 'select' | 'bool'
  options?: string[]
  placeholder?: string
}

const STEP_FIELDS: Partial<Record<StepType, FieldSpec[]>> = {
  goto: [
    { key: 'url', label: '网址', kind: 'text', placeholder: '${target} 或 https://…' },
    { key: 'waitUntil', label: '等待', kind: 'select', options: ['domcontentloaded', 'load', 'networkidle'] }
  ],
  click: [{ key: 'selector', label: '选择器', kind: 'text', placeholder: '#submit' }],
  fill: [
    { key: 'selector', label: '选择器', kind: 'text' },
    { key: 'value', label: '内容', kind: 'text', placeholder: '${username}' },
    { key: 'submit', label: '填完按回车', kind: 'bool' }
  ],
  press: [
    { key: 'selector', label: '选择器（留空按在页面上）', kind: 'text' },
    { key: 'key', label: '按键', kind: 'text', placeholder: 'Enter / Tab / a' }
  ],
  select: [
    { key: 'selector', label: '选择器', kind: 'text' },
    { key: 'value', label: '选项值', kind: 'text' }
  ],
  hover: [{ key: 'selector', label: '选择器', kind: 'text' }],
  wait: [
    { key: 'selector', label: '选择器（留空等页面加载）', kind: 'text' },
    { key: 'state', label: '状态', kind: 'select', options: ['visible', 'attached', 'hidden', 'detached'] }
  ],
  sleep: [{ key: 'ms', label: '毫秒', kind: 'number' }],
  text: [
    { key: 'selector', label: '选择器', kind: 'text' },
    { key: 'variable', label: '写入变量', kind: 'text', placeholder: 'title' },
    { key: 'optional', label: '不存在也不报错', kind: 'bool' }
  ],
  attribute: [
    { key: 'selector', label: '选择器', kind: 'text' },
    { key: 'attribute', label: '属性名', kind: 'text', placeholder: 'href' },
    { key: 'variable', label: '写入变量', kind: 'text' },
    { key: 'optional', label: '不存在也不报错', kind: 'bool' }
  ],
  assertText: [
    { key: 'selector', label: '选择器（留空断言整页）', kind: 'text' },
    { key: 'expected', label: '期望文本', kind: 'text' },
    { key: 'mode', label: '方式', kind: 'select', options: ['contains', 'equals', 'regex'] }
  ],
  assertVisible: [{ key: 'selector', label: '选择器', kind: 'text' }],
  evaluate: [
    { key: 'expression', label: 'JS 表达式（在页面里执行）', kind: 'text', placeholder: 'document.title' },
    { key: 'variable', label: '写入变量（可留空）', kind: 'text' }
  ],
  screenshot: [
    { key: 'filename', label: '文件名', kind: 'text', placeholder: 'step.png' },
    { key: 'selector', label: '只截某个元素（可留空）', kind: 'text' }
  ],
  setVariable: [
    { key: 'name', label: '变量名', kind: 'text' },
    { key: 'value', label: '值', kind: 'text' }
  ],
  log: [{ key: 'message', label: '内容', kind: 'text', placeholder: '抓到：${title}' }],
  if: [{ key: 'condition', label: '条件', kind: 'text', placeholder: '$title contains ok 写法见下方说明' }],
  loop: [
    { key: 'times', label: '次数', kind: 'number' },
    { key: 'untilCondition', label: '提前退出条件（可留空）', kind: 'text' },
    { key: 'intervalMs', label: '每轮间隔(ms)', kind: 'number' }
  ]
}

const ADDABLE: StepType[] = (Object.keys(TYPE_LABEL) as StepType[]).filter((t) => t !== 'if' && t !== 'loop')

let seq = 0
function newStep(type: StepType): RpaStep {
  seq += 1
  const base = { id: `s${Date.now().toString(36)}${seq}`, type } as unknown as RpaStep
  const s = base as unknown as Record<string, unknown>
  if (type === 'sleep') s.ms = 500
  if (type === 'loop') s.times = 2
  if (type === 'if') {
    s.condition = ''
    s.then = []
    s.else = []
  }
  if (type === 'loop') s.steps = []
  return base
}

/** 递归更新：按 id 找到步骤并合并字段 */
function patchStep(steps: RpaStep[], id: string, patch: Record<string, unknown>): RpaStep[] {
  return steps.map((s) => {
    if (s.id === id) return { ...(s as unknown as Record<string, unknown>), ...patch } as unknown as RpaStep
    const any = s as unknown as Record<string, unknown>
    const out = { ...any } as unknown as Record<string, unknown>
    if (s.type === 'if') {
      out.then = patchStep((any.then as RpaStep[]) ?? [], id, patch)
      if (Array.isArray(any.else)) out.else = patchStep(any.else as RpaStep[], id, patch)
    }
    if (s.type === 'loop') out.steps = patchStep((any.steps as RpaStep[]) ?? [], id, patch)
    return out as unknown as RpaStep
  })
}

function removeStep(steps: RpaStep[], id: string): RpaStep[] {
  return steps
    .filter((s) => s.id !== id)
    .map((s) => {
      const any = s as unknown as Record<string, unknown>
      const out = { ...any } as unknown as Record<string, unknown>
      if (s.type === 'if') {
        out.then = removeStep((any.then as RpaStep[]) ?? [], id)
        if (Array.isArray(any.else)) out.else = removeStep(any.else as RpaStep[], id)
      }
      if (s.type === 'loop') out.steps = removeStep((any.steps as RpaStep[]) ?? [], id)
      return out as unknown as RpaStep
    })
}

/** 往某个块（if.then / if.else / loop.steps）里追加步骤；parentId 为 null 时追加到顶层 */
function appendStep(steps: RpaStep[], parentId: string | null, step: RpaStep): RpaStep[] {
  if (parentId === null) return [...steps, step]
  // else 分支在界面上用 `${id}#else` 标识，因为它和 then 属于同一个步骤
  const isElse = parentId.endsWith('#else')
  const owner = isElse ? parentId.slice(0, -'#else'.length) : parentId
  return steps.map((s) => {
    const any = s as unknown as Record<string, unknown>
    if (s.id === owner) {
      const out = { ...any } as unknown as Record<string, unknown>
      if (s.type === 'if') {
        if (isElse) out.else = [...(((any.else as RpaStep[]) ?? [])), step]
        else out.then = [...((any.then as RpaStep[]) ?? []), step]
      }
      if (s.type === 'loop' && !isElse) out.steps = [...((any.steps as RpaStep[]) ?? []), step]
      return out as unknown as RpaStep
    }
    const out = { ...any } as unknown as Record<string, unknown>
    if (s.type === 'if') {
      out.then = appendStep((any.then as RpaStep[]) ?? [], parentId, step)
      if (Array.isArray(any.else)) out.else = appendStep(any.else as RpaStep[], parentId, step)
    }
    if (s.type === 'loop') out.steps = appendStep((any.steps as RpaStep[]) ?? [], parentId, step)
    return out as unknown as RpaStep
  })
}

/** 在同一层里上下移动 */
function moveStep(steps: RpaStep[], id: string, dir: -1 | 1): RpaStep[] {
  const idx = steps.findIndex((s) => s.id === id)
  if (idx >= 0) {
    const target = idx + dir
    if (target < 0 || target >= steps.length) return steps
    const next = [...steps]
    const [item] = next.splice(idx, 1)
    next.splice(target, 0, item)
    return next
  }
  return steps.map((s) => {
    const any = s as unknown as Record<string, unknown>
    const out = { ...any } as unknown as Record<string, unknown>
    if (s.type === 'if') {
      out.then = moveStep((any.then as RpaStep[]) ?? [], id, dir)
      if (Array.isArray(any.else)) out.else = moveStep(any.else as RpaStep[], id, dir)
    }
    if (s.type === 'loop') out.steps = moveStep((any.steps as RpaStep[]) ?? [], id, dir)
    return out as unknown as RpaStep
  })
}

function FieldInput({
  spec,
  value,
  onChange
}: {
  spec: FieldSpec
  value: unknown
  onChange(v: string | number | boolean): void
}): React.JSX.Element {
  if (spec.kind === 'bool') {
    return (
      <label className="flex items-center gap-1.5 text-xs text-slate-300">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {spec.label}
      </label>
    )
  }
  if (spec.kind === 'select') {
    return (
      <select className={`${field} text-xs py-1`} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">默认</option>
        {(spec.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-slate-400">
      {spec.label}
      <input
        type={spec.kind === 'number' ? 'number' : 'text'}
        className={`${field} text-xs py-1 w-64`}
        value={String(value ?? '')}
        placeholder={spec.placeholder}
        onChange={(e) => onChange(spec.kind === 'number' ? Number(e.target.value) : e.target.value)}
      />
    </label>
  )
}

function AddStep({ onAdd }: { onAdd(type: StepType): void }): React.JSX.Element {
  const [type, setType] = useState<StepType>('click')
  return (
    <span className="flex items-center gap-1">
      <select className={`${field} text-xs py-1`} value={type} onChange={(e) => setType(e.target.value as StepType)}>
        {ADDABLE.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <button onClick={() => onAdd(type)} className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs">
        添加
      </button>
    </span>
  )
}

function Children({
  steps,
  depth,
  parentId,
  onPatch,
  onRemove,
  onMove,
  onAddChild
}: {
  steps: RpaStep[]
  depth: number
  parentId: string
  onPatch(id: string, patch: Record<string, unknown>): void
  onRemove(id: string): void
  onMove(id: string, dir: -1 | 1): void
  onAddChild(parentId: string, type: StepType): void
}): React.JSX.Element {
  return (
    <>
      {steps.map((child) => (
        <StepRow
          key={child.id}
          step={child}
          depth={depth}
          onPatch={onPatch}
          onRemove={onRemove}
          onMove={onMove}
          onAddChild={onAddChild}
        />
      ))}
      <div className="py-1" style={{ marginLeft: depth * 12 + 14 }}>
        <AddStep onAdd={(t) => onAddChild(parentId, t)} />
      </div>
    </>
  )
}

function StepRow(props: {
  step: RpaStep
  depth: number
  onPatch(id: string, patch: Record<string, unknown>): void
  onRemove(id: string): void
  onMove(id: string, dir: -1 | 1): void
  onAddChild(parentId: string, type: StepType): void
}): React.JSX.Element {
  const { step, depth, onPatch, onRemove, onMove, onAddChild } = props
  const s = step as unknown as Record<string, unknown>
  const specs = STEP_FIELDS[step.type] ?? []
  const handlers = { onPatch, onRemove, onMove, onAddChild }
  return (
    <div className="border-l border-slate-800 pl-2" style={{ marginLeft: depth * 12 }}>
      <div className="py-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="checkbox"
            checked={step.enabled !== false}
            title="临时禁用该步骤"
            onChange={(e) => onPatch(step.id, { enabled: e.target.checked })}
          />
          <select
            className={`${field} text-xs py-1`}
            value={step.type}
            onChange={(e) => onPatch(step.id, { type: e.target.value })}
          >
            {(Object.keys(TYPE_LABEL) as StepType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <input
            className={`${field} text-xs py-1 w-44`}
            placeholder="说明（可留空）"
            value={String(s.label ?? '')}
            onChange={(e) => onPatch(step.id, { label: e.target.value })}
          />
          <span className="ml-auto flex items-center gap-1">
            <button onClick={() => onMove(step.id, -1)} className="text-xs text-slate-400 hover:text-slate-200" title="上移">
              ↑
            </button>
            <button onClick={() => onMove(step.id, 1)} className="text-xs text-slate-400 hover:text-slate-200" title="下移">
              ↓
            </button>
            <button onClick={() => onRemove(step.id)} className="text-xs text-rose-300 hover:text-rose-200" title="删除">
              删除
            </button>
          </span>
        </div>

        {specs.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-end gap-2">
            {specs.map((spec) => (
              <FieldInput
                key={spec.key}
                spec={spec}
                value={s[spec.key]}
                onChange={(v) => onPatch(step.id, { [spec.key]: v })}
              />
            ))}
          </div>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <label className="flex items-center gap-1">
            失败时
            <select
              className={`${field} text-[11px] py-0.5`}
              value={String(s.onError ?? 'stop')}
              onChange={(e) => onPatch(step.id, { onError: e.target.value })}
            >
              <option value="stop">停止流程</option>
              <option value="continue">跳过继续</option>
              <option value="retry">重试</option>
            </select>
          </label>
          {s.onError === 'retry' && (
            <>
              <label className="flex items-center gap-1">
                次数
                <input
                  type="number"
                  className={`${field} text-[11px] py-0.5 w-16`}
                  value={Number(s.retryCount ?? 2)}
                  onChange={(e) => onPatch(step.id, { retryCount: Number(e.target.value) })}
                />
              </label>
              <label className="flex items-center gap-1">
                间隔 ms
                <input
                  type="number"
                  className={`${field} text-[11px] py-0.5 w-20`}
                  value={Number(s.retryDelayMs ?? 500)}
                  onChange={(e) => onPatch(step.id, { retryDelayMs: Number(e.target.value) })}
                />
              </label>
            </>
          )}
          <label className="flex items-center gap-1">
            超时 ms
            <input
              type="number"
              className={`${field} text-[11px] py-0.5 w-20`}
              value={Number(s.timeoutMs ?? 0)}
              onChange={(e) => onPatch(step.id, { timeoutMs: Number(e.target.value) || undefined })}
            />
          </label>
        </div>
      </div>

      {step.type === 'if' && (
        <>
          <div className="text-[11px] text-emerald-300/80" style={{ marginLeft: (depth + 1) * 12 + 14 }}>
            then 分支
          </div>
          <Children steps={(s.then as RpaStep[]) ?? []} depth={depth + 1} parentId={step.id} {...handlers} />
          <div className="text-[11px] text-amber-300/80" style={{ marginLeft: (depth + 1) * 12 + 14 }}>
            else 分支（可选）
          </div>
          <Children steps={(s.else as RpaStep[]) ?? []} depth={depth + 1} parentId={`${step.id}#else`} {...handlers} />
        </>
      )}

      {step.type === 'loop' && (
        <Children steps={(s.steps as RpaStep[]) ?? []} depth={depth + 1} parentId={step.id} {...handlers} />
      )}
    </div>
  )
}

const EVENT_CLASS: Record<string, string> = {
  ok: 'text-emerald-300',
  failed: 'text-rose-300',
  skipped: 'text-slate-500',
  retrying: 'text-amber-300'
}

export default function RpaView(): React.JSX.Element {
  const { profiles, load: loadProfiles } = useApp()
  const {
    flows,
    runs,
    flowId,
    profileId,
    saving,
    running,
    events,
    validation,
    error,
    notice,
    load,
    select,
    create,
    update,
    remove,
    validate,
    sample,
    run,
    stop,
    pushEvent,
    clearEvents
  } = useRpa()
  const [flow, setFlow] = useState<RpaFlow | null>(null)
  const [paramsText, setParamsText] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [jsonText, setJsonText] = useState('')

  useEffect(() => {
    void loadProfiles()
    void load()
  }, [loadProfiles, load])

  useEffect(() => {
    if (!profileId && profiles.length) select(flowId || flows[0]?.id || '', profiles[0].id)
  }, [profiles, profileId, flowId, flows, select])

  useEffect(() => {
    const off = window.api.events.onRpaStep((e) => pushEvent(e))
    return off
  }, [pushEvent])

  // 切换流程时载入编辑副本（改坏了可以重新选择来丢弃）
  useEffect(() => {
    const rec = flows.find((f) => f.id === flowId)
    if (!rec) {
      setFlow(null)
      return
    }
    setFlow(JSON.parse(JSON.stringify(rec.flow)) as RpaFlow)
    setParamsText(Object.entries(rec.flow.params ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'))
  }, [flowId, flows])

  const params = useMemo(() => {
    const out: Record<string, string> = {}
    for (const line of paramsText.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1)
    }
    return out
  }, [paramsText])

  const handlers = useMemo(
    () => ({
      onPatch: (id: string, patch: Record<string, unknown>) =>
        setFlow((f) => (f ? { ...f, steps: patchStep(f.steps, id, patch) } : f)),
      onRemove: (id: string) => setFlow((f) => (f ? { ...f, steps: removeStep(f.steps, id) } : f)),
      onMove: (id: string, dir: -1 | 1) => setFlow((f) => (f ? { ...f, steps: moveStep(f.steps, id, dir) } : f)),
      onAddChild: (parentId: string, type: StepType) =>
        setFlow((f) => (f ? { ...f, steps: appendStep(f.steps, parentId, newStep(type)) } : f))
    }),
    []
  )

  const save = async (): Promise<void> => {
    if (!flow) return
    const payload = { ...flow, params }
    if (flow.id) await update(flow.id, payload)
    else await create(payload)
  }

  const newFromSample = async (): Promise<void> => {
    const s = await sample()
    if (!s) return
    const rec = await create({ ...s, id: undefined, name: `${s.name}（副本）` })
    if (rec) select(rec.id)
  }

  const blank = (): void => {
    setFlow({ version: 1, name: '新流程', description: '', steps: [], params: {} })
    setParamsText('')
    select('')
  }

  return (
    <>
      <header className="flex items-center gap-3 px-5 py-3 border-b border-[#1e293b] bg-[#0d1117]/50">
        <select className={field} value={flowId} onChange={(e) => select(e.target.value)}>
          <option value="">（未选择）</option>
          {flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}（{f.stepCount} 步）
            </option>
          ))}
        </select>
        <button onClick={() => void newFromSample()} className={btn}>
          从示例新建
        </button>
        <button onClick={blank} className={btn}>
          空白流程
        </button>
        <span className="ml-auto flex items-center gap-2">
          <select className={field} value={profileId} onChange={(e) => select(flowId, e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={() => void save()} disabled={saving || !flow} className={primary}>
            {saving ? '保存中…' : flow?.id ? '保存' : '创建'}
          </button>
          <button
            onClick={() => void run()}
            disabled={running || !flow?.id || !profileId}
            className="rounded-md bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          >
            {running ? '执行中…' : '运行'}
          </button>
          <button onClick={() => void stop()} disabled={!running} className={btn}>
            停止
          </button>
        </span>
      </header>

      {notice && (
        <div className="mx-5 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2 text-sm text-rose-200">{error}</div>
      )}

      <div className="flex-1 overflow-auto px-5 py-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
        <section className="space-y-3">
          {!flow ? (
            <div className="card p-5 text-sm text-slate-400 leading-relaxed">
              选一个流程来编辑，或点「从示例新建」看一个可直接跑的例子。
              <br />
              <span className="text-slate-500">
                流程会在所选环境的真实内核里执行，用的是那个环境的指纹、代理与登录态。步骤里用 ${'{name}'} 引用变量；
                条件支持 and / or / not、== != &gt; &lt; 以及 exists / empty。
              </span>
            </div>
          ) : (
            <>
              <div className="card p-3 space-y-2">
                <input
                  className={`${field} w-full`}
                  value={flow.name}
                  onChange={(e) => setFlow((f) => (f ? { ...f, name: e.target.value } : f))}
                />
                <input
                  className={`${field} w-full`}
                  placeholder="说明"
                  value={flow.description ?? ''}
                  onChange={(e) => setFlow((f) => (f ? { ...f, description: e.target.value } : f))}
                />
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <label className="flex items-center gap-1">
                    默认超时 ms
                    <input
                      type="number"
                      className={`${field} text-xs py-1 w-24`}
                      value={Number(flow.defaultTimeoutMs ?? 15000)}
                      onChange={(e) => setFlow((f) => (f ? { ...f, defaultTimeoutMs: Number(e.target.value) } : f))}
                    />
                  </label>
                  <button
                    onClick={() => void validate({ ...flow, params })}
                    className="ml-auto rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs"
                  >
                    校验
                  </button>
                  <button onClick={() => setShowJson((v) => !v)} className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs">
                    {showJson ? '隐藏 JSON' : 'JSON'}
                  </button>
                  {flow.id && (
                    <button
                      onClick={() => void remove(flow.id as string)}
                      className="rounded bg-rose-500/15 hover:bg-rose-500/25 px-2 py-1 text-xs text-rose-200"
                    >
                      删除流程
                    </button>
                  )}
                </div>
                <label className="block text-[11px] text-slate-400">
                  流程参数（每行 name=value，步骤里用 ${'{name}'} 引用）
                  <textarea
                    className={`${field} w-full h-16 font-mono text-xs mt-1`}
                    value={paramsText}
                    onChange={(e) => setParamsText(e.target.value)}
                  />
                </label>
              </div>

              {validation && (
                <div
                  className={`rounded-lg border p-3 text-xs leading-relaxed ${
                    validation.ok
                      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                      : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                  }`}
                >
                  {validation.ok
                    ? `校验通过：${validation.stepCount} 步${validation.warns ? `，${validation.warns} 条提示` : ''}`
                    : `${validation.errors} 处错误：`}
                  {validation.issues.slice(0, 12).map((i, idx) => (
                    <div key={idx} className={i.level === 'error' ? '' : 'text-amber-200/80'}>
                      [{i.level}] {i.path} — {i.message}
                    </div>
                  ))}
                </div>
              )}

              <div className="card p-3">
                {flow.steps.map((step) => (
                  <StepRow key={step.id} step={step} depth={0} {...handlers} />
                ))}
                <div className="pt-2">
                  <AddStep onAdd={(t) => setFlow((f) => (f ? { ...f, steps: appendStep(f.steps, null, newStep(t)) } : f))} />
                </div>
              </div>

              {showJson && (
                <div className="card p-3 space-y-2">
                  <textarea
                    className={`${field} w-full h-56 font-mono text-[11px]`}
                    value={jsonText || JSON.stringify({ ...flow, params }, null, 2)}
                    onChange={(e) => setJsonText(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      try {
                        setFlow(JSON.parse(jsonText) as RpaFlow)
                      } catch {
                        /* 忽略：保持当前编辑副本不变 */
                      }
                      setJsonText('')
                    }}
                    disabled={!jsonText}
                    className="rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-xs disabled:opacity-40"
                  >
                    应用 JSON
                  </button>
                </div>
              )}
            </>
          )}
        </section>
        <section className="space-y-3">
          <div className="card">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1e293b] bg-[#0d1117]/50">
              <h3 className="text-xs font-semibold text-slate-300">本次执行</h3>
              <span className="text-[11px] text-slate-500">{events.length} 条</span>
              <button onClick={clearEvents} className="ml-auto text-[11px] text-slate-400 hover:text-slate-200">
                清空
              </button>
            </div>
            <div className="max-h-80 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
              {events.length === 0 ? (
                <div className="text-slate-500 px-1 py-2">还没有日志。选好流程与环境后点「运行」。</div>
              ) : (
                events.map((e, i) => (
                  <div key={i} style={{ paddingLeft: e.depth * 12 }} className={EVENT_CLASS[e.status] ?? 'text-slate-300'}>
                    <span className="text-slate-600">{new Date(e.ts).toLocaleTimeString()}</span> {e.label} — {e.message}
                    {e.durationMs > 0 && <span className="text-slate-600"> ({e.durationMs}ms)</span>}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <h3 className="section-header text-xs font-semibold text-slate-300">历史运行</h3>
            <div className="max-h-72 overflow-auto">
              {runs.length === 0 ? (
                <div className="text-slate-500 text-xs px-3 py-2">还没有运行记录。</div>
              ) : (
                runs.map((r) => (
                  <div key={r.id} className="px-3 py-2 border-t border-slate-800/70 text-xs flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        r.status === 'success'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : r.status === 'running'
                            ? 'bg-sky-500/15 text-sky-300'
                            : 'bg-rose-500/15 text-rose-300'
                      }`}
                    >
                      {r.status}
                    </span>
                    <span className="text-slate-300">{r.flowName}</span>
                    <span className="text-slate-500">
                      ok={r.ok} failed={r.failed} · {(r.durationMs / 1000).toFixed(1)}s · {formatTime(r.startedAt)}
                    </span>
                    {r.error && <span className="text-rose-300 truncate max-w-full">{r.error}</span>}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  )
}