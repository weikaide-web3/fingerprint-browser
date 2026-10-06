import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, ensureDir, dbFile } from '../../src/main/paths'
import { initDatabase, closeDatabase } from '../../src/main/db'
import {
  createProfile,
  getProfile,
  deleteProfile,
  restoreProfile,
  purgeProfile,
  listTrashProfiles
} from '../../src/main/db/repositories/profiles'
import {
  createProxy,
  getProxy,
  deleteProxy,
  listTrashProxies
} from '../../src/main/db/repositories/proxies'
import { startProfile } from '../../src/main/services/browser'
import { listProfiles } from '../../src/main/db/repositories/profiles'
import { usageCounts, boundProfiles } from '../../src/main/services/proxies'

/**
 * 回收站（软删除）回归测试。
 *
 * 覆盖两个真实 bug 的修复：
 * 1. getProfile 必须过滤 deleted_at —— 回收站里的环境不能再被读取 / 启动 / 操作。
 * 2. 环境绑定的代理若被软删除，getProfile 不应再把这条「已删除」代理显示为绑定。
 *
 * 纯数据库层，不启动 Chromium，所以很快。
 */

let tmpDir = ''

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-trash-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  initDatabase(dbFile())
})

afterAll(() => {
  closeDatabase()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('回收站：环境软删除', () => {
  it('删除后 getProfile 返回 null，回收站可见，恢复后重新可读', () => {
    const p = createProfile({ name: 'trash-profile-1' })
    expect(getProfile(p.id)).not.toBeNull()

    deleteProfile(p.id)
    // Bug 1 核心断言：软删除后按 id 读不到
    expect(getProfile(p.id)).toBeNull()
    // 但回收站里能看到
    expect(listTrashProfiles().some((x) => x.id === p.id)).toBe(true)

    restoreProfile(p.id)
    expect(getProfile(p.id)).not.toBeNull()
    expect(listTrashProfiles().some((x) => x.id === p.id)).toBe(false)
  })

  it('软删除的环境无法被启动（startProfile 抛 not found）', async () => {
    const p = createProfile({ name: 'trash-profile-2' })
    deleteProfile(p.id)
    await expect(startProfile(p.id)).rejects.toThrow(/not found/)
  })

  it('彻底删除后从回收站消失且不可恢复', () => {
    const p = createProfile({ name: 'trash-profile-3' })
    deleteProfile(p.id)
    purgeProfile(p.id)
    expect(getProfile(p.id)).toBeNull()
    expect(listTrashProfiles().some((x) => x.id === p.id)).toBe(false)
  })
})

describe('回收站：环境绑定的代理软删除', () => {
  it('代理被软删除后，环境的 getProfile 不再显示该代理为绑定', () => {
    const proxy = createProxy({ name: 'trash-proxy', scheme: 'http', host: '1.2.3.4', port: 8080 })
    const p = createProfile({ name: 'trash-with-proxy', proxyMode: 'bind', proxyId: proxy.id })

    // 绑定可见
    const bound = getProfile(p.id)
    expect(bound?.proxy?.id).toBe(proxy.id)

    // 代理进回收站
    deleteProxy(proxy.id)
    expect(getProxy(proxy.id)).toBeNull()
    expect(listTrashProxies().some((x) => x.id === proxy.id)).toBe(true)

    // Bug 1b：环境仍在，但不应把已删除的代理显示为绑定
    const after = getProfile(p.id)
    expect(after).not.toBeNull()
    expect(after?.proxy).toBeNull()
  })

  it('列表视图（listProfiles）也不显示已删除代理的绑定，与详情一致', () => {
    const proxy = createProxy({ name: 'trash-proxy-list', scheme: 'http', host: '5.6.7.8', port: 9000 })
    const p = createProfile({ name: 'trash-list-consistency', proxyMode: 'bind', proxyId: proxy.id })

    // 绑定可见（列表 + 详情都显示）
    expect(listProfiles({ search: 'trash-list-consistency', limit: 50 }).items[0]?.proxy?.id).toBe(proxy.id)
    expect(getProfile(p.id)?.proxy?.id).toBe(proxy.id)

    deleteProxy(proxy.id)

    // Bug 修复：列表视图同样不应把已删除代理显示为绑定
    const inList = listProfiles({ search: 'trash-list-consistency', limit: 50 }).items[0]
    expect(inList).toBeDefined()
    expect(inList?.proxy).toBeNull()
  })

  it('usageCounts / boundProfiles 排除已删除环境', () => {
    const proxy = createProxy({ name: 'trash-proxy-usage', scheme: 'http', host: '9.9.9.9', port: 8081 })
    const p1 = createProfile({ name: 'usage-keep', proxyMode: 'bind', proxyId: proxy.id })
    const p2 = createProfile({ name: 'usage-drop', proxyMode: 'bind', proxyId: proxy.id })

    expect(usageCounts()[proxy.id]).toBe(2)
    expect(boundProfiles(proxy.id).map((x) => x.id).sort()).toEqual([p1.id, p2.id].sort())

    deleteProfile(p2.id)

    // Bug 修复：删除环境后，代理的绑定计数与绑定列表都应下降
    expect(usageCounts()[proxy.id]).toBe(1)
    expect(boundProfiles(proxy.id).map((x) => x.id)).toEqual([p1.id])
  })

  it('恢复环境时连带恢复其绑定的、仍在回收站里的代理', () => {
    const proxy = createProxy({ name: 'trash-proxy-restore', scheme: 'http', host: '8.8.8.8', port: 8082 })
    const p = createProfile({ name: 'restore-cascade', proxyMode: 'bind', proxyId: proxy.id })

    // 环境和代理一起进回收站
    deleteProfile(p.id)
    deleteProxy(proxy.id)
    expect(getProxy(proxy.id)).toBeNull()

    // 恢复环境 → 绑定的代理也应被连带恢复
    restoreProfile(p.id)
    expect(getProfile(p.id)).not.toBeNull()
    expect(getProxy(proxy.id)).not.toBeNull()
    // 绑定关系重新可见
    expect(getProfile(p.id)?.proxy?.id).toBe(proxy.id)
  })
})
