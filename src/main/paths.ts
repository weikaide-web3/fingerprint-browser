import fs from 'node:fs'
import path from 'node:path'

export const APP_NAME = 'FingerprintBrowser'

let baseDir = ''
let resourcesBase = ''

/** 由主进程注入，测试环境可注入临时目录（避免依赖 Electron） */
export function setDataDir(dir: string): void {
  baseDir = dir
}

export function setResourcesDir(dir: string): void {
  resourcesBase = dir
}

export function dataDir(): string {
  if (!baseDir) throw new Error('dataDir 未初始化：请先调用 setDataDir()')
  return baseDir
}

export function dbFile(): string {
  return path.join(dataDir(), 'app.db')
}

export function profilesRootDir(): string {
  return path.join(dataDir(), 'profiles')
}

/**
 * profile id 必须是安全字符集。
 *
 * id 会被拼进 user-data-dir，而清理登录态 / 崩溃恢复会对该目录做
 * rmSync(recursive)。createProfile 允许调用方传入 id（克隆、导入、API 都要用），
 * 若不校验，"../../../../tmp/evil" 就能让删除操作逃出 profiles 根目录。
 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function assertSafeId(id: string): string {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    throw new Error(`非法的环境 id：${JSON.stringify(id)}（只允许字母、数字、下划线、连字符，长度 1-64）`)
  }
  return id
}

export function profileDataDir(profileId: string): string {
  return path.join(profilesRootDir(), assertSafeId(profileId))
}

export function profileUserDataDir(profileId: string): string {
  return path.join(profileDataDir(profileId), 'user-data')
}

export function profileCookiesDir(profileId: string): string {
  return path.join(profileDataDir(profileId), 'session')
}

export function profileDownloadsDir(profileId: string): string {
  return path.join(profileDataDir(profileId), 'downloads')
}

export function profileExtensionsDir(profileId: string): string {
  return path.join(profileDataDir(profileId), 'extensions')
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function resourcesDir(): string {
  return resourcesBase || path.join(process.cwd(), 'resources')
}

