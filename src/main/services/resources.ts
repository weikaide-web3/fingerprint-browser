import { execFile } from 'node:child_process'
import { profilesRootDir } from '../paths'
import { allSessions } from '../browser/registry'
import type { ProfileResource, ResourceReport } from '@shared/ops'

/**
 * 资源监控：列出本 app 启动的 Chrome 进程及其内存占用，
 * 并统计每个环境的进程数（主进程 + GPU + 多个 renderer/helper）。
 *
 * 用 ps 读取 RSS（KB）。只匹配 --user-data-dir 指向本 app profiles 目录的进程，
 * 不会把用户自己的 Chrome 算进来。
 *
 * 必须异步：之前用 execSync，这条命令要扫全系统进程表（maxBuffer 16MB），
 * 而资源监控页是轮询的 —— 同步执行会**阻塞整个主进程**，
 * 期间所有 IPC、定时器、Chrome 的 CDP 回调全部停摆，界面卡死。
 */

function runPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}


function classifyRole(cmd: string): string {
  if (cmd.includes('--type=renderer')) return 'renderer'
  if (cmd.includes('--type=gpu-process')) return 'gpu'
  if (cmd.includes('--type=utility')) return 'utility'
  if (cmd.includes('--type=')) return 'helper'
  return 'browser'
}

/**
 * 解析 ps 输出，按 profileId 聚合进程。纯函数，便于单测。
 * byProfile 会被就地补充/更新。
 */
export function parsePsOutput(out: string, root: string, byProfile: Map<string, ProfileResource>): void {
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // pid rss %cpu command
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const rssBytes = Number(m[2]) * 1024
    const cpuPercent = Number(m[3])
    const cmd = m[4]
    if (!cmd.includes('--user-data-dir=')) continue
    if (!cmd.includes(root)) continue
    // 提取 user-data-dir 路径里的 profileId：.../profiles/<id>/user-data
    const udMatch = cmd.match(/--user-data-dir=([^\s]+)/)
    if (!udMatch) continue
    const udPath = udMatch[1]
    const idMatch = udPath.match(/profiles\/([^/]+)\/user-data/)
    if (!idMatch) continue
    const profileId = idMatch[1]
    let entry = byProfile.get(profileId)
    if (!entry) {
      entry = { profileId, name: profileId, running: true, processCount: 0, totalRssBytes: 0, processes: [] }
      byProfile.set(profileId, entry)
    }
    entry.processCount += 1
    entry.totalRssBytes += rssBytes
    entry.processes.push({ pid, rssBytes, cpuPercent, role: classifyRole(cmd) })
  }
}

export async function report(): Promise<ResourceReport> {
  const root = profilesRootDir()
  const byProfile = new Map<string, ProfileResource>()

  // 先把所有运行中的 session 登记进来（拿到 profileId + name）
  for (const s of allSessions()) {
    byProfile.set(s.profileId, {
      profileId: s.profileId,
      name: s.profileId,
      running: true,
      processCount: 0,
      totalRssBytes: 0,
      processes: []
    })
  }
  // 名字从 registry 拿不到，这里用 profileId 占位；UI 端会用 profile 列表补名字

  try {
    const out = await runPs(['-axo', 'pid=,rss=,%cpu=,command='])
    parsePsOutput(out, root, byProfile)
  } catch {
    /* ps 不可用 */
  }

  const profiles = [...byProfile.values()].filter((p) => p.processCount > 0)
  const totalRssBytes = profiles.reduce((s, p) => s + p.totalRssBytes, 0)
  const totalProcesses = profiles.reduce((s, p) => s + p.processCount, 0)

  return {
    profiles,
    totalRssBytes,
    totalProcesses,
    runningCount: profiles.length,
    checkedAt: Date.now()
  }
}
