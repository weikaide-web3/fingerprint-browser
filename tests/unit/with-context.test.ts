import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * withContext 的「谁拉起谁关闭」所有权回归测试。
 *
 * 这是本次审查里最隐蔽的一个缺陷：自动化 API 正在启动环境 A 的同时，
 * 一个检测/会话操作也走 withContext，它看到 launched 就以为是自己拉起的，
 * 跑完把 API 刚启动的内核关掉。用户侧的症状是「脚本连不上」，
 * 而日志里完全看不出是谁关的。
 *
 * 修复靠 launchProfile 返回的 spawned 标志：只有真的 spawn 了进程的那一方才负责 stop。
 * 这里用 mock 把内核层替掉，专门验证 stopProfile 的调用次数。
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  launchProfile: vi.fn(),
  stopProfile: vi.fn(),
  getProfile: vi.fn(),
  typedSetting: vi.fn()
}))

vi.mock('../../src/main/browser/registry', () => ({ getSession: mocks.getSession }))
vi.mock('../../src/main/browser/launcher', () => ({
  launchProfile: mocks.launchProfile,
  stopProfile: mocks.stopProfile
}))
vi.mock('../../src/main/db/repositories/profiles', () => ({ getProfile: mocks.getProfile }))
vi.mock('../../src/main/settings/defs', () => ({ typedSetting: mocks.typedSetting }))
vi.mock('../../src/main/lib/log', () => ({ log: vi.fn(), logError: vi.fn() }))

const { withContext } = await import('../../src/main/browser/with-context')

function fakeContext(id: string) {
  return { __id: id } as never
}

/** 从 mock context 里取回标记；BrowserContext 与自定义字段无重叠，必须经 unknown */
function idOf(ctx: unknown): string {
  return (ctx as unknown as { __id: string }).__id
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProfile.mockReturnValue({ id: 'p1', name: 'test' })
  mocks.typedSetting.mockReturnValue(false)
  mocks.stopProfile.mockResolvedValue(undefined)
  mocks.getSession.mockReturnValue(undefined)
})

/**
 * 模拟注册表：前 `cold` 次查询看不到会话（环境没在跑），之后才看得到。
 * withContext 会查两次（进入串行区前后各一次），launchProfile 之后还会再查一次，
 * 所以 cold=2 表示「本次由 withContext 负责拉起」。
 */
function registry(ctx: { __id: string }, cold: number) {
  let n = 0
  mocks.getSession.mockImplementation(() => (n++ < cold ? undefined : { context: ctx }))
}

describe('withContext 的关闭所有权', () => {
  it('环境已在运行时复用 context，且绝不关闭', async () => {
    registry(fakeContext('existing'), 0)
    const seen: boolean[] = []
    const out = await withContext('p1', '测试', async (ctx, reused) => {
      seen.push(reused)
      return idOf(ctx)
    })
    expect(out).toBe('existing')
    expect(seen).toEqual([true])
    expect(mocks.launchProfile).not.toHaveBeenCalled()
    expect(mocks.stopProfile).not.toHaveBeenCalled()
  })

  it('自己拉起时（spawned:true）用完必须关闭', async () => {
    registry(fakeContext('fresh'), 2)
    mocks.launchProfile.mockResolvedValue({ spawned: true, profileId: 'p1' } as never)
    const out = await withContext('p1', '测试', async (c, reused) => {
      expect(reused).toBe(false)
      return idOf(c)
    })
    expect(out).toBe('fresh')
    expect(mocks.launchProfile).toHaveBeenCalledTimes(1)
    expect(mocks.stopProfile).toHaveBeenCalledTimes(1)
    expect(mocks.stopProfile).toHaveBeenCalledWith('p1')
  })

  it('复用别人刚拉起的会话（spawned:false）时不得关闭', async () => {
    // 场景：并发下 launchProfile 返回 spawned:false（另一方正持有该 profile 的启动），
    // 此时 withContext 只是借用者，关掉它会打断真正的启动方。
    registry(fakeContext('borrowed'), 2)
    mocks.launchProfile.mockResolvedValue({ spawned: false, profileId: 'p1' } as never)
    const out = await withContext('p1', '测试', async (c, reused) => {
      expect(reused).toBe(true)
      return idOf(c)
    })
    expect(out).toBe('borrowed')
    expect(mocks.stopProfile).not.toHaveBeenCalled()
  })

  it('fn 抛错时仍按所有权清理，且不吞掉原始错误', async () => {
    registry(fakeContext('fresh'), 2)
    mocks.launchProfile.mockResolvedValue({ spawned: true, profileId: 'p1' } as never)
    await expect(
      withContext('p1', '测试', async () => {
        throw new Error('业务失败')
      })
    ).rejects.toThrow('业务失败')
    expect(mocks.stopProfile).toHaveBeenCalledTimes(1)
  })

  it('fn 抛错且不是自己拉起时不去关闭', async () => {
    registry(fakeContext('borrowed'), 2)
    mocks.launchProfile.mockResolvedValue({ spawned: false, profileId: 'p1' } as never)
    await expect(
      withContext('p1', '测试', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(mocks.stopProfile).not.toHaveBeenCalled()
  })

  it('内核未能启动时报错而不是拿着 undefined 继续跑', async () => {
    mocks.getSession.mockReturnValue(undefined)
    mocks.launchProfile.mockResolvedValue({ spawned: true, profileId: 'p1' } as never)
    await expect(withContext('p1', '测试', async () => 'never')).rejects.toThrow(/内核未能启动/)
    // 拉起了进程就必须回收，否则留下孤儿 chromium
    expect(mocks.stopProfile).toHaveBeenCalledTimes(1)
  })

  it('环境不存在时直接报错，不尝试拉起', async () => {
    mocks.getProfile.mockReturnValue(undefined)
    await expect(withContext('missing', '测试', async () => 'x')).rejects.toThrow(/环境不存在/)
    expect(mocks.launchProfile).not.toHaveBeenCalled()
  })

  it('同一环境的并发临时操作串行执行，不会互相踩内核', async () => {
    const ctx = fakeContext('c')
    let live = 0
    let maxLive = 0
    let launched = 0
    mocks.getSession.mockImplementation(() => (launched > 0 ? { context: ctx } : undefined))
    mocks.launchProfile.mockImplementation(async () => {
      launched += 1
      return { spawned: true, profileId: 'p1' } as never
    })

    const task = () =>
      withContext('p1', '测试', async () => {
        live += 1
        maxLive = Math.max(maxLive, live)
        await new Promise((r) => setTimeout(r, 10))
        live -= 1
        return 'ok'
      })

    const rs = await Promise.all([task(), task(), task()])
    expect(rs).toEqual(['ok', 'ok', 'ok'])
    // 串行：任何时刻最多只有一个任务在内核里
    expect(maxLive).toBe(1)
  })

  it('访问真实站点时强制有头，即使用户开了 transientHeadless', async () => {
    registry(fakeContext('c'), 2)
    mocks.launchProfile.mockResolvedValue({ spawned: true, profileId: 'p1' } as never)
    mocks.typedSetting.mockImplementation((key: string) => (key === 'transientHeadless' ? true : false))
    await withContext('p1', '登录', async () => 'ok', { realSite: true })
    const arg = mocks.launchProfile.mock.calls[0][0] as { headless: boolean }
    expect(arg.headless).toBe(false)
  })

  it('普通临时操作尊重 transientHeadless 设置', async () => {
    registry(fakeContext('c'), 2)
    mocks.launchProfile.mockResolvedValue({ spawned: true, profileId: 'p1' } as never)
    mocks.typedSetting.mockImplementation((key: string) => (key === 'transientHeadless' ? true : false))
    await withContext('p1', '导出 cookie', async () => 'ok')
    const arg = mocks.launchProfile.mock.calls[0][0] as { headless: boolean }
    expect(arg.headless).toBe(true)
  })
})
