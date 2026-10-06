import { evalCondition, interpolate } from './expr'
import type { FlowIssue, FlowValidation, RpaFlow, RpaStep, StepType } from '@shared/rpa'

export type { FlowIssue, FlowValidation }

/**
 * 流程静态校验：跑之前就把明显会失败的写法挑出来。
 * 执行到第 12 步才发现选择器写错，代价是白等半分钟 + 一个半完成的状态；
 * 所以点「运行」之前先过一遍。
 */

const NEEDS_SELECTOR: Partial<Record<StepType, boolean>> = {
  click: true,
  fill: true,
  select: true,
  hover: true,
  text: true,
  attribute: true,
  assertVisible: true
}

const MAX_DEPTH = 6

function checkUrl(url: string): string | null {
  if (!url) return '缺少 url'
  if (/^javascript:/i.test(url)) return '不允许 javascript: 地址'
  // 含变量占位的 url 要等运行时才展开，静态阶段没法解析，只做危险协议检查
  if (/\$\{?[A-Za-z0-9_.-]+\}?/.test(url)) {
    if (/\b(javascript|data):/i.test(url)) return 'url 里不要写 javascript: / data: 地址'
    return null
  }
  try {
    const u = new URL(url)
    if (!['http:', 'https:', 'file:', 'about:', 'data:'].includes(u.protocol)) return `不支持的协议：${u.protocol}`
    return null
  } catch {
    return `url 无法解析：${url}`
  }
}

export function validateFlow(flow: RpaFlow): FlowValidation {
  const issues: FlowIssue[] = []
  const ids = new Set<string>()
  let stepCount = 0

  const add = (level: 'error' | 'warn', stepId: string, path: string, message: string): void => {
    issues.push({ level, stepId, path, message })
  }

  const walk = (steps: RpaStep[], path: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      add('error', path, path, `嵌套超过 ${MAX_DEPTH} 层，流程太深难以维护`)
      return
    }
    for (const step of steps) {
      stepCount += 1
      const here = `${path}/${step.type}#${step.id}`
      if (!step.id) {
        add('error', path, here, '步骤缺少 id')
      } else if (ids.has(step.id)) {
        add('error', step.id, here, `步骤 id 重复：${step.id}（日志与失败定位会混乱）`)
      } else {
        ids.add(step.id)
      }

      const s = step as unknown as Record<string, unknown>
      if (NEEDS_SELECTOR[step.type] && !String(s.selector ?? '').trim()) add('error', step.id, here, `${step.type} 缺少 selector`)
      if (step.type === 'goto') {
        const err = checkUrl(String(s.url ?? ''))
        if (err) add('error', step.id, here, err)
      }
      if (step.type === 'fill' && s.value === undefined) add('error', step.id, here, 'fill 缺少 value')
      if (step.type === 'press' && !String(s.key ?? '').trim()) add('error', step.id, here, 'press 缺少按键名')
      if (step.type === 'text' && !String(s.variable ?? '').trim()) add('error', step.id, here, 'text 需要指定写入的变量名')
      if (step.type === 'attribute' && !String(s.attribute ?? '').trim()) add('error', step.id, here, 'attribute 缺少属性名')
      if (step.type === 'assertText' && s.expected === undefined) add('error', step.id, here, 'assertText 缺少 expected')
      if (step.type === 'sleep' && !(Number(s.ms) > 0)) add('error', step.id, here, 'sleep 的毫秒数必须大于 0')
      if (step.type === 'evaluate' && !String(s.expression ?? '').trim()) add('error', step.id, here, 'evaluate 缺少表达式')
      if (step.type === 'log' && !String(s.message ?? '').trim()) add('warn', step.id, here, 'log 内容为空')

      // 变量名写错不会报错，只会静默变成空串 —— 这是最难查的一类 bug，所以提前提示
      const refs = new Set<string>()
      for (const field of ['url', 'value', 'expected', 'message', 'selector']) {
        const raw = s[field]
        if (typeof raw === 'string') {
          for (const m of raw.matchAll(/\$\{?([A-Za-z0-9_.-]+)\}?/g)) refs.add(m[1])
        }
      }
      const declared = new Set(Object.keys(flow.params ?? {}))
      for (const name of refs) {
        if (!declared.has(name)) add('warn', step.id, here, `变量 ${name} 未在流程参数里声明，确认它由前面的步骤写入`)
      }

      if (step.type === 'if') {
        const r = evalCondition(String(s.condition ?? ''), {})
        if (r.error) add('error', step.id, here, `if 条件有误：${r.error}`)
        walk((s.then as RpaStep[]) ?? [], here, depth + 1)
        if (Array.isArray(s.else)) walk(s.else as RpaStep[], `${here}/else`, depth + 1)
      }
      if (step.type === 'loop') {
        const times = Number(s.times)
        if (!Number.isInteger(times) || times < 1) add('error', step.id, here, 'loop 次数必须是 >= 1 的整数')
        if (times > 200) add('warn', step.id, here, `循环 ${times} 次偏多，确认不是死循环`)
        if (s.untilCondition !== undefined) {
          const r = evalCondition(String(s.untilCondition ?? ''), {})
          if (r.error) add('error', step.id, here, `loop 退出条件有误：${r.error}`)
        }
        walk((s.steps as RpaStep[]) ?? [], `${here}/loop`, depth + 1)
      }
    }
  }

  if (!flow?.name?.trim()) add('error', '', '/', '流程缺少名称')
  if (!Array.isArray(flow?.steps) || flow.steps.length === 0) add('error', '', '/', '流程没有任何步骤')
  walk(flow?.steps ?? [], '', 1)

  const errors = issues.filter((i) => i.level === 'error').length
  const warns = issues.filter((i) => i.level === 'warn').length
  return { issues, errors, warns, stepCount, ok: errors === 0 }
}

/** 条件语法的单独预检：服务层用它把错误定位到具体步骤 */
export function precheckConditions(flow: RpaFlow, vars: Record<string, string | number | boolean | null>): FlowIssue[] {
  const out: FlowIssue[] = []
  const walk = (steps: RpaStep[]): void => {
    for (const step of steps) {
      const s = step as unknown as Record<string, unknown>
      if (step.type === 'if') {
        const r = evalCondition(String(s.condition ?? ''), vars)
        if (r.error) out.push({ level: 'error', stepId: step.id, path: `if#${step.id}`, message: r.error })
        walk((s.then as RpaStep[]) ?? [])
        walk((s.else as RpaStep[]) ?? [])
      }
      if (step.type === 'loop') {
        if (s.untilCondition !== undefined) {
          const r = evalCondition(String(s.untilCondition ?? ''), vars)
          if (r.error) out.push({ level: 'error', stepId: step.id, path: `loop#${step.id}`, message: r.error })
        }
        walk((s.steps as RpaStep[]) ?? [])
      }
    }
  }
  walk(flow?.steps ?? [])
  return out
}

/** 步骤的默认展示文案：用户没写 label 时，日志里也能看懂在干什么 */
export function describeStep(step: RpaStep): string {
  const s = step as unknown as Record<string, unknown>
  if (step.label) return interpolate(String(step.label), {}).text
  switch (step.type) {
    case 'goto':
      return `打开 ${s.url}`
    case 'click':
      return `点击 ${s.selector}`
    case 'fill':
      return `填写 ${s.selector}`
    case 'press':
      return `按键 ${s.key}${s.selector ? ` (${s.selector})` : ''}`
    case 'select':
      return `选择 ${s.selector} = ${s.value}`
    case 'hover':
      return `悬停 ${s.selector}`
    case 'wait':
      return s.selector ? `等待 ${s.selector} ${s.state ?? 'visible'}` : '等待页面加载'
    case 'sleep':
      return `等待 ${s.ms}ms`
    case 'text':
      return `抓取文本 ${s.selector} → $${s.variable}`
    case 'attribute':
      return `抓取属性 ${s.selector}[${s.attribute}] → $${s.variable}`
    case 'assertText':
      return `断言文本${s.selector ? ` (${s.selector})` : ' (整页)'} ${s.mode ?? 'contains'} "${s.expected}"`
    case 'assertVisible':
      return `断言可见 ${s.selector}`
    case 'evaluate':
      return '执行 JS 表达式'
    case 'screenshot':
      return `截图 ${s.filename ?? 'step.png'}`
    case 'setVariable':
      return `设置变量 $${s.name}`
    case 'log':
      return `记录：${s.message}`
    case 'if':
      return `如果 ${s.condition}`
    case 'loop':
      return `循环 ${s.times} 次${s.untilCondition ? `（直到 ${s.untilCondition}）` : ''}`
    default:
      // 走到这里说明是尚未支持的步骤类型（新增类型时的兜底）
      return String((step as { type: string }).type)
  }
}