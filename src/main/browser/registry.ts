import type { BrowserContext } from 'playwright-core'
import type { ProfileStatus } from '@shared/types'

export interface RunningSession {
  profileId: string
  context: BrowserContext
  pid: number
  wsEndpoint: string
  httpEndpoint: string
  startedAt: number
  status: ProfileStatus
  closing: boolean
  /** 是否以 headless 启动：窗口尺寸相关的处理只在有头模式下有意义 */
  headless: boolean
  /** 带凭据的代理会在本机起一个 relay，随会话一起关闭 */
  relay?: { stop(): Promise<void> }
  /** 进程自然退出时（用户点 X）的回调，用于通知 UI 更新状态 */
  onExit?: () => void
  /** 请求的窗口尺寸与窗口管理器真正落地的尺寸；两者不等说明被显示器夹小 */
  windowBounds?: { want: { width: number; height: number }; got: { width: number; height: number } }
  /** 本次启动占用的调试端口，会话关闭时释放回端口池 */
  debugPort?: number
}

const sessions = new Map<string, RunningSession>()

export function getSession(profileId: string): RunningSession | undefined {
  return sessions.get(profileId)
}

export function setSession(session: RunningSession): void {
  sessions.set(session.profileId, session)
}

export function deleteSession(profileId: string): void {
  sessions.delete(profileId)
}

export function allSessions(): RunningSession[] {
  return [...sessions.values()]
}

export function activeIds(): string[] {
  return [...sessions.keys()]
}

export function getStatus(profileId: string): ProfileStatus {
  return sessions.get(profileId)?.status ?? 'stopped'
}
