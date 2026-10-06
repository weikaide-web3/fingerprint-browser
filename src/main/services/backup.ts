import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { dataDir, ensureDir } from '../paths'
import { getDb, isDbReady } from '../db'
import { log } from '../lib/log'
import { newId } from '../lib/id'
import type { BackupInfo } from '@shared/ops'

/**
 * 数据备份 / 恢复。
 *
 * 备份内容 = app.db（SQLite 主库）+ profiles/（每个环境的 user-data、session、downloads）。
 * 用 macOS 自带的 ditto 打成 .zip（保留符号链接与权限）。
 *
 * 备份目录在 dataDir 之外（userData/backups），避免备份套备份。
 * 恢复是破坏性操作：先把当前数据反向备份一份（pre-restore），再覆盖。
 */

function backupsRoot(): string {
  return ensureDir(path.join(dataDir(), '..', 'backups'))
}

/**
 * ditto 打包/解压必须异步：备份包含整个 profiles/（每个环境的 user-data 可能有
 * 几百 MB），execFileSync 会把主进程事件循环整段堵住 —— 期间窗口无响应、
 * IPC 全部排队、内核的 CDP 连接也可能超时。
 */
function runDitto(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ditto', args, { maxBuffer: 16 * 1024 * 1024 }, (err) => {
      if (err) reject(new Error(`ditto ${args[0]} 失败：${err.message}`))
      else resolve()
    })
  })
}

function infoFromZip(file: string): BackupInfo {
  const stat = fs.statSync(file)
  const base = path.basename(file, '.zip')
  // 文件名格式：fpb-backup-<ts>-<id>
  const m = base.match(/fpb-backup-(\d+)-(.+)$/)
  return {
    id: m ? m[2] : base,
    name: base,
    file,
    sizeBytes: stat.size,
    createdAt: m ? Number(m[1]) : stat.mtimeMs
  }
}

export function list(): BackupInfo[] {
  const root = backupsRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.zip') && f.startsWith('fpb-backup-'))
    .map((f) => infoFromZip(path.join(root, f)))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 取一份一致性数据库快照到 dest。
 *
 * 原实现是 fs.copyFileSync(db) 再把 -wal / -shm 一起复制，注释却写着
 * 「用 .backup 保证一致性快照」—— 实现与注释不符。在线复制正在写的 WAL 库
 * 可能拿到时间点不一致的快照：主文件是 T1、WAL 里混着 T2 的页，
 * 恢复时表现为「部分写入丢失」这种最难查的症状。
 *
 * SQLite 的 backup API 会按页一致性复制并正确处理 WAL，所以：
 * - 库开着（用户在界面上点备份）→ 用 db.backup()；
 * - 库已关（恢复流程里先 closeDatabase 再做 pre-restore 快照）→ 直接复制，
 *   此时 WAL 已在关闭时 checkpoint 回主文件，复制是安全的。
 */
async function snapshotDatabase(dest: string): Promise<void> {
  const db = path.join(dataDir(), 'app.db')
  if (isDbReady()) {
    await getDb().backup(dest)
    return
  }
  if (!fs.existsSync(db)) return
  fs.copyFileSync(db, dest)
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(db + suffix)) fs.copyFileSync(db + suffix, dest + suffix)
  }
}

export async function create(label?: string): Promise<BackupInfo> {
  const ts = Date.now()
  const id = newId('bk')
  const safeLabel = (label ?? '').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40)
  const name = `fpb-backup-${ts}-${id}${safeLabel ? `-${safeLabel}` : ''}.zip`
  const target = path.join(backupsRoot(), name)

  const profiles = path.join(dataDir(), 'profiles')

  // 用临时 staging 目录收集要打包的内容，避免把 backups 自身打进去
  const staging = ensureDir(path.join(backupsRoot(), `.staging-${id}`))
  try {
    await snapshotDatabase(path.join(staging, 'app.db'))
    if (fs.existsSync(profiles)) {
      // fs.promises.cp：递归复制同样不能同步做，否则大 profile 直接卡住主进程
      await fs.promises.cp(profiles, path.join(staging, 'profiles'), { recursive: true, dereference: false })
    }
    // ditto 打包（macOS）
    await runDitto(['-c', '-k', staging, target])
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }

  const info = infoFromZip(target)
  log('backup', `已创建备份 ${name}（${(info.sizeBytes / 1024 / 1024).toFixed(1)} MB）`)
  return info
}

export function remove(id: string): boolean {
  const found = list().find((b) => b.id === id)
  if (!found) return false
  fs.rmSync(found.file, { force: true })
  log('backup', `已删除备份 ${found.name}`)
  return true
}

/**
 * 从备份恢复。破坏性：先反向备份当前数据，再解压覆盖。
 * 返回 pre-restore 备份的 id。
 */
export async function restore(id: string): Promise<{ preRestoreId: string }> {
  const found = list().find((b) => b.id === id)
  if (!found) throw new Error(`备份不存在：${id}`)
  // 恢复是整库文件替换：库还开着就覆盖 app.db 会让连接指向被换掉的文件，
  // 后续所有 SQL 都在写一个「已经不属于当前数据」的句柄。必须先关。
  if (isDbReady()) throw new Error('数据库仍在打开状态，恢复前必须先关闭（由主进程调用 closeDatabase）')

  // 1. 先备份当前状态，万一恢复失败还能回退
  const pre = await create('pre-restore')

  // 2. 解压到临时目录
  const extract = ensureDir(path.join(backupsRoot(), `.extract-${newId('ex')}`))
  try {
    await runDitto(['-x', '-k', found.file, extract])

    const newDb = path.join(extract, 'app.db')
    const newProfiles = path.join(extract, 'profiles')

    // 3. 覆盖 app.db（连同 wal/shm）
    const db = path.join(dataDir(), 'app.db')
    for (const suffix of ['', '-wal', '-shm']) {
      const src = newDb + suffix
      const dst = db + suffix
      if (fs.existsSync(src)) fs.copyFileSync(src, dst)
      else if (fs.existsSync(dst)) fs.rmSync(dst, { force: true })
    }

    // 4. 覆盖 profiles/
    const profiles = path.join(dataDir(), 'profiles')
    if (fs.existsSync(newProfiles)) {
      fs.rmSync(profiles, { recursive: true, force: true })
      fs.cpSync(newProfiles, profiles, { recursive: true, dereference: false })
    }

    log('backup', `已从备份 ${found.name} 恢复（恢复前已自动备份为 ${pre.name}）`)
    return { preRestoreId: pre.id }
  } finally {
    fs.rmSync(extract, { recursive: true, force: true })
  }
}

/** 打开备份所在目录（Finder） */
export function revealDir(): string {
  return backupsRoot()
}
