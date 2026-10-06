import electronLog from 'electron-log/main'
import { attachLogger, logFilePath } from './log'

let initialised = false

/** 仅在 Electron 主进程调用：把日志接管到 electron-log 文件输出 */
export function initLogging(): void {
  if (initialised) return
  initialised = true
  electronLog.transports.file.level = 'info'
  electronLog.transports.file.maxSize = 10 * 1024 * 1024
  electronLog.transports.file.resolvePathFn = () => logFilePath()
  electronLog.initialize()
  attachLogger(electronLog)
}
