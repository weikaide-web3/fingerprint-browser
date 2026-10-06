import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, ensureDir, dbFile } from '../../src/main/paths'
import { initDatabase, closeDatabase, isDbReady } from '../../src/main/db'
import { createProfile, getProfile, listProfiles } from '../../src/main/db/repositories/profiles'
import { importBundle } from '../../src/main/services/port'
import { create, restore, list } from '../../src/main/services/backup'
import type { ProfileBundle } from '@shared/ops'

/**
 * 导入 / 备份恢复回归测试（纯 DB + 文件，不启动 Chromium）。
 *
 * 覆盖两个真实 bug 的修复：
 * 1. importBundle 先校验再落库：畸形 bundle 不应留下「半创建」的环境。
 * 2. 备份恢复走「关库 → 覆盖文件 → 重开」：恢复后连接与磁盘一致，
 *    读到的是快照内容，而不是被 WAL/页缓存污染的旧状态。
 */

let tmpDir = ''

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-port-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  initDatabase(dbFile())
})

afterAll(() => {
  if (isDbReady()) closeDatabase()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('环境导入 importBundle', () => {
  it('拒绝不支持的版本，且不创建任何环境', () => {
    const before = listProfiles().total
    expect(() => importBundle({ version: 99 } as unknown as ProfileBundle)).toThrow(/格式版本/)
    expect(listProfiles().total).toBe(before)
  })

  it('缺少环境配置时抛错，且不留下半创建的环境', () => {
    const before = listProfiles().total
    const bad = {
      version: 1,
      exportedAt: Date.now(),
      profile: null,
      fingerprint: null,
      proxy: null
    } as unknown as ProfileBundle
    expect(() => importBundle(bad)).toThrow(/环境配置/)
    expect(listProfiles().total).toBe(before)
  })

  it('合法 bundle（无指纹）可导入，环境数 +1', () => {
    const before = listProfiles().total
    const bundle: ProfileBundle = {
      version: 1,
      exportedAt: Date.now(),
      profile: {
        name: '导入的环境',
        color: null,
        icon: null,
        note: 'x',
        kernel: 'chromium',
        fingerprintMode: 'auto',
        proxyMode: 'none',
        startupUrls: [],
        launchArgs: [],
        sessionPolicy: 'keep',
        retention: { maxAgeDays: 0, onExpire: 'keep', protectedKeys: [] },
        tags: []
      },
      fingerprint: null,
      proxy: null
    }
    const r = importBundle(bundle)
    expect(r.profileId).toBeTruthy()
    expect(getProfile(r.profileId)?.name).toBe('导入的环境')
    expect(listProfiles().total).toBe(before + 1)
  })
})

describe('备份恢复 restore（关库→覆盖→重开）', () => {
  it('恢复后读到的是快照内容，且数据库连接可用', async () => {
    const a = createProfile({ name: 'A-快照内' })
    // create 走 SQLite 在线 backup API，所以是异步的
    const snap = await create('snap')
    // 快照之后再建一个 B，恢复后 B 应消失
    const b = createProfile({ name: 'B-快照后' })
    expect(getProfile(a.id)).toBeTruthy()
    expect(getProfile(b.id)).toBeTruthy()

    // 模拟 ipc 处理器的顺序：关库 → 恢复 → 重开
    closeDatabase()
    const res = await restore(snap.id)
    expect(res.preRestoreId).toBeTruthy()
    initDatabase(dbFile())

    expect(isDbReady()).toBe(true)
    expect(getProfile(a.id)?.name).toBe('A-快照内')
    expect(getProfile(b.id)).toBeNull()
    expect(list().some((x) => x.id === snap.id)).toBe(true)
  })

  it('库仍打开时拒绝恢复（整库文件替换不能让连接指向被换掉的文件）', async () => {
    expect(isDbReady()).toBe(true)
    const snapId = list()[0]?.id
    expect(snapId).toBeTruthy()
    await expect(restore(snapId as string)).rejects.toThrow(/数据库仍在打开状态/)
  })
})