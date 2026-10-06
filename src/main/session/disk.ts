import fs from 'node:fs'
import path from 'node:path'
import { profileUserDataDir } from '../paths'
import type { CleanupTarget } from '@shared/session'

/**
 * 隔离目录体积统计与清理。
 * 全部走磁盘：内核没跑的时候才能安全删除，运行中一律拒绝（避免删到一半被内核重新写回）。
 */

export function dirSize(dir: string): number {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) total += dirSize(full)
    else {
      try {
        total += fs.statSync(full).size
      } catch {
        /* 竞态删除，忽略 */
      }
    }
  }
  return total
}

/** Chromium 里可安全重建的缓存目录（删了不影响登录态） */
const CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/ScriptCache',
  'Default/blob_storage',
  'Default/Download Service',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache'
]

/** 登录态本体：cookie + 本地存储，删掉等于退出登录 */
const SESSION_PATHS = ['Default/Cookies', 'Default/Local Storage', 'Default/Session Storage', 'Default/Web Data']

function removeTree(target: string): number {
  let size = 0
  try {
    const st = fs.lstatSync(target)
    size = st.isDirectory() ? dirSize(target) : st.size
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    return -1
  }
  return size
}

export interface DiskCleanup {
  removed: string[]
  freedBytes: number
}

/** 返回被删除的相对路径与释放的字节数；未命中的目标静默跳过 */
export function cleanupUserData(userDataDir: string, target: CleanupTarget): DiskCleanup {
  const removed: string[] = []
  let freedBytes = 0
  const wipe = (rel: string): void => {
    const freed = removeTree(path.join(userDataDir, rel))
    if (freed >= 0) {
      removed.push(rel)
      freedBytes += freed
    }
  }
  if (target === 'cache') {
    for (const d of CACHE_DIRS) wipe(d)
  } else if (target === 'cookies') {
    for (const p of SESSION_PATHS) wipe(p)
  } else {
    const freed = removeTree(userDataDir)
    if (freed >= 0) {
      removed.push('.')
      freedBytes += freed
    }
  }
  return { removed, freedBytes }
}

export function userDataSize(profileId: string): number {
  return dirSize(profileUserDataDir(profileId))
}
