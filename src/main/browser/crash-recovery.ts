import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { profilesRootDir } from '../paths'
import { log } from '../lib/log'

/**
 * 崩溃恢复 / 残留进程清理。
 *
 * 上次异常退出（崩溃、强杀、断电）会留下：
 * 1. 仍在运行的 Chrome 进程（带 --user-data-dir 指向本 app 的 profiles 目录）；
 * 2. 每个 profile 目录里的 SingletonLock / SingletonCookie / SingletonSocket 锁文件，
 *    导致下次启动报「profile 被占用」。
 *
 * 启动时调用一次：先杀掉残留 Chrome 进程，再清掉所有锁文件。
 */

/** 异步读 ps 输出：绝不能用 execSync —— 它会阻塞主进程事件循环 */
function readPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}


/**
 * 判断一条 ps 命令行是否是指向本 app profiles 目录的残留浏览器进程。
 * 纯函数，便于单测：绝不误杀用户自己的 Chrome（命令行不含本 app root）。
 */
export function isOrphanChromiumCommand(cmd: string, root: string, selfPid: number, pid: number): boolean {
  if (!pid || pid === selfPid) return false
  return cmd.includes('--user-data-dir=') && cmd.includes(root)
}

/** 解析 `ps -axo pid=,command=` 的一行，返回 { pid, cmd } 或 null */
export function parsePsLine(line: string): { pid: number; cmd: string } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const sp = trimmed.indexOf(' ')
  if (sp < 0) return null
  const pid = Number(trimmed.slice(0, sp))
  if (!Number.isFinite(pid)) return null
  return { pid, cmd: trimmed.slice(sp + 1) }
}

/** 列出命令行里引用了本 app profiles 目录的残留 Chrome 进程 pid */
async function findOrphanPids(): Promise<number[]> {
  const root = profilesRootDir()
  const pids: number[] = []
  try {
    const out = await readPs()
    const selfPid = process.pid
    for (const line of out.split('\n')) {
      const parsed = parsePsLine(line)
      if (!parsed) continue
      // 只匹配指向本 app profiles 目录的浏览器进程，绝不误杀用户自己的 Chrome
      if (isOrphanChromiumCommand(parsed.cmd, root, selfPid, parsed.pid)) pids.push(parsed.pid)
    }
  } catch {
    /* ps 不可用时忽略 */
  }
  return pids
}

/**
 * 优雅清理残留 Chrome 进程：先 SIGTERM 让 Chrome 写回 leveldb/Cookie，
 * 等待 graceMs 后仍存活的再 SIGKILL。返回处理数。
 * 绝不误杀用户自己的 Chrome（命令行不含本 app root）。
 */
export async function killOrphanChromium(graceMs = 2000): Promise<number> {
  const pids = await findOrphanPids()
  if (pids.length === 0) return 0
  // 第一轮：SIGTERM 优雅退出
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 进程可能已退出 */
    }
  }
  // 等待 Chrome 自行退出
  await new Promise((resolve) => setTimeout(resolve, graceMs))
  // 第二轮：仍存活的强制 SIGKILL
  const survivors = new Set(await findOrphanPids())
  for (const pid of pids) {
    if (survivors.has(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
  return pids.length
}

/** 清掉所有 profile 目录里的 Singleton* 锁文件 */
export function clearProfileLocks(): number {
  const root = profilesRootDir()
  let cleared = 0
  if (!fs.existsSync(root)) return 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const userData = path.join(root, entry.name, 'user-data')
    if (!fs.existsSync(userData)) continue
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(userData, lock)
      try {
        if (fs.existsSync(p)) {
          fs.rmSync(p, { force: true })
          cleared += 1
        }
      } catch {
        /* ignore */
      }
    }
  }
  return cleared
}

/** 启动时一次性清理：返回清理统计 */
export async function cleanupOrphanProcesses(): Promise<{ killed: number; locksCleared: number }> {
  const killed = await killOrphanChromium()
  const locksCleared = clearProfileLocks()
  if (killed || locksCleared) {
    log('recovery', `启动清理：处理 ${killed} 个残留内核进程，清除 ${locksCleared} 个锁文件`)
  }
  return { killed, locksCleared }
}
