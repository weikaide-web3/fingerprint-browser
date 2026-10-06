/**
 * RPA 流程契约（主进程执行 + 渲染进程编辑共用）。
 *
 * 流程用「带层级的步骤列表」而不是自由图：条件/循环都是块，
 * 执行顺序 = 缩进顺序，用户看得懂，校验和回放也简单。
 * 存进 rpa_flows.graph 时是 JSON 字符串。
 */

import type { HumanizeConfig } from './humanize'

export const FLOW_VERSION = 1

export type StepType =
  | 'goto'
  | 'click'
  | 'fill'
  | 'press'
  | 'select'
  | 'hover'
  | 'wait'
  | 'sleep'
  | 'text'
  | 'attribute'
  | 'assertText'
  | 'assertVisible'
  | 'evaluate'
  | 'screenshot'
  | 'setVariable'
  | 'log'
  | 'if'
  | 'loop'

export type ErrorPolicy = 'stop' | 'continue' | 'retry'
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle'
export type AssertMode = 'contains' | 'equals' | 'regex'

export interface StepBase {
  /** 流程内唯一 id，日志与失败定位都靠它 */
  id: string
  type: StepType
  /** 界面上的说明；留空时执行器会给一个默认描述 */
  label?: string
  /** 失败怎么处理：停止流程 / 跳过 / 重试若干次后停止 */
  onError?: ErrorPolicy
  retryCount?: number
  retryDelayMs?: number
  timeoutMs?: number
  /** 为真才执行；用于临时禁用某一步而不删掉它 */
  enabled?: boolean
}

export interface GotoStep extends StepBase {
  type: 'goto'
  url: string
  waitUntil?: WaitUntil
}
export interface ClickStep extends StepBase {
  type: 'click'
  selector: string
}
export interface FillStep extends StepBase {
  type: 'fill'
  selector: string
  value: string
  /** 填完按回车（登录表单常见） */
  submit?: boolean
}
export interface PressStep extends StepBase {
  type: 'press'
  /** 留空表示按在页面上 */
  selector?: string
  key: string
}
export interface SelectStep extends StepBase {
  type: 'select'
  selector: string
  value: string
}
export interface HoverStep extends StepBase {
  type: 'hover'
  selector: string
}
export interface WaitStep extends StepBase {
  type: 'wait'
  selector?: string
  state?: 'attached' | 'visible' | 'hidden' | 'detached'
}
export interface SleepStep extends StepBase {
  type: 'sleep'
  ms: number
}
export interface TextStep extends StepBase {
  type: 'text'
  selector: string
  /** 抓到的文本写进这个变量 */
  variable: string
  /** 元素不存在时不报错，变量置空 */
  optional?: boolean
}
export interface AttributeStep extends StepBase {
  type: 'attribute'
  selector: string
  attribute: string
  variable: string
  optional?: boolean
}
export interface AssertTextStep extends StepBase {
  type: 'assertText'
  /** 留空表示断言整页文本 */
  selector?: string
  expected: string
  mode?: AssertMode
}
export interface AssertVisibleStep extends StepBase {
  type: 'assertVisible'
  selector: string
}
export interface EvaluateStep extends StepBase {
  type: 'evaluate'
  /** 在页面里执行的 JS 表达式（不是任意脚本文件） */
  expression: string
  variable?: string
}
export interface ScreenshotStep extends StepBase {
  type: 'screenshot'
  /** 只写文件名，实际落在本次运行的日志目录里 */
  filename?: string
  selector?: string
}
export interface SetVariableStep extends StepBase {
  type: 'setVariable'
  name: string
  value: string
}
export interface LogStep extends StepBase {
  type: 'log'
  message: string
}
export interface IfStep extends StepBase {
  type: 'if'
  condition: string
  then: RpaStep[]
  else?: RpaStep[]
}
export interface LoopStep extends StepBase {
  type: 'loop'
  /** 循环次数；也可用 untilCondition 提前退出 */
  times: number
  untilCondition?: string
  /** 每轮之间的等待 */
  intervalMs?: number
  steps: RpaStep[]
}

export type RpaStep =
  | GotoStep
  | ClickStep
  | FillStep
  | PressStep
  | SelectStep
  | HoverStep
  | WaitStep
  | SleepStep
  | TextStep
  | AttributeStep
  | AssertTextStep
  | AssertVisibleStep
  | EvaluateStep
  | ScreenshotStep
  | SetVariableStep
  | LogStep
  | IfStep
  | LoopStep

export interface RpaFlow {
  version: number
  id?: string
  name: string
  description?: string | null
  steps: RpaStep[]
  /** 流程级默认超时 */
  defaultTimeoutMs?: number
  /** 启动流程前注入的变量，步骤里用 ${name} 引用 */
  params?: Record<string, string>
  /**
   * 人类化行为覆盖。留空则用全局设置里的默认预设。
   * 真实站点（Google / X）必须开：瞬移鼠标 + 0ms 填表是教科书级机器人特征。
   */
  humanize?: Partial<HumanizeConfig>
}

export interface FlowRecord {
  id: string
  name: string
  description: string | null
  flow: RpaFlow
  stepCount: number
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  lastRunStatus: string | null
}

export interface FlowIssue {
  level: 'error' | 'warn'
  stepId: string
  path: string
  message: string
}

export interface FlowValidation {
  issues: FlowIssue[]
  errors: number
  warns: number
  stepCount: number
  ok: boolean
}

export type StepStatus = 'ok' | 'failed' | 'skipped' | 'retrying'

export interface StepLogEntry {
  ts: number
  stepId: string
  type: StepType
  label: string
  status: StepStatus
  message: string
  durationMs: number
  /** 在步骤树里的深度，界面用来缩进 */
  depth: number
  value?: string
}

export interface RunStats {
  ok: number
  failed: number
  skipped: number
  retried: number
  durationMs: number
}

export interface RunResult {
  id: string
  flowId: string
  flowName: string
  profileId: string
  status: 'running' | 'success' | 'failed' | 'stopped'
  startedAt: number
  finishedAt: number | null
  stats: RunStats
  log: StepLogEntry[]
  /** 本次运行产出的文件（日志、截图） */
  files: string[]
  error: string | null
}

export interface RunSummary {
  id: string
  flowId: string
  flowName: string
  profileId: string
  status: string
  startedAt: number
  finishedAt: number | null
  ok: number
  failed: number
  skipped: number
  durationMs: number
  logPath: string | null
  error: string | null
}