import path from 'node:path'
import { dataDir } from '../paths'

interface Logger {
  info(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** 默认走 console；主进程启动后用 attachLogger 接管到 electron-log */
let logger: Logger = {
  info: (...args) => console.log(...args),
  error: (...args) => console.error(...args)
}

export function attachLogger(next: Logger): void {
  logger = next
}

export function logFilePath(): string {
  return path.join(dataDir(), 'logs', 'main.log')
}

export function log(scope: string, message: string, meta?: unknown): void {
  const text = meta === undefined ? message : `${message} ${safeStringify(meta)}`
  logger.info(`[${scope}] ${text}`)
}

export function logError(scope: string, message: string, err?: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : safeStringify(err)
  logger.error(`[${scope}] ${message}${detail ? ` :: ${detail}` : ''}`)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

