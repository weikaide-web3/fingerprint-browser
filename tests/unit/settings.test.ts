import { DEFAULT_RETENTION } from '@shared/session'
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '../../src/main/paths'
import { SETTING_DEFS, findDef, normalizeAndValidate, typedSetting } from '../../src/main/settings/defs'
import { buildLaunchArgs, parseArgsTemplate, sanitizeUserArgs, SUPPRESS_BUILD_INFOBAR } from '../../src/main/browser/args'
import { findBrandedChrome, resolveChromiumExecutable } from '../../src/main/browser/executable'
import type { Profile } from '@shared/types'

/**
 * 设置模块单测：默认值、类型归一化、非法值拦截，
 * 以及「启动参数模板」如何进入最终的内核命令行。
 * 这里不碰 SQLite（原生模块按 Electron ABI 编译），只测纯逻辑。
 */

// buildLaunchArgs 会算下载目录，需要一个数据根目录
setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-settings-test-')))

describe('设置定义与校验', () => {
  it('每个设置项都有默认值与说明，key 不重复', () => {
    const keys = new Set<string>()
    for (const def of SETTING_DEFS) {
      expect(def.label, `${def.key} 缺少展示名`).toBeTruthy()
      expect(def.description.length, `${def.key} 缺少说明`).toBeGreaterThan(5)
      expect(keys.has(def.key), `重复的 key：${def.key}`).toBe(false)
      keys.add(def.key)
    }
  })

  it('库里没有值时返回定义里的默认值', () => {
    expect(typedSetting<number>('apiPort')).toBe(52222)
    expect(typedSetting<boolean>('apiEnabled')).toBe(true)
    expect(typedSetting<string>('defaultSessionPolicy')).toBe('keep')
    // 调用点显式给的兜底优先于定义默认值（定义默认值只在没传兜底时生效）
    expect(typedSetting<number>('apiPort', 9999)).toBe(9999)
    expect(typedSetting<number>('no.such.key', 7)).toBe(7)
  })

  it('未知设置项直接拒绝，避免拼错 key 后静默失效', () => {
    expect(() => normalizeAndValidate('nope', 1)).toThrow(/未知设置项/)
    expect(findDef('nope')).toBeUndefined()
  })

  it('数字项做类型转换并校验范围', () => {
    expect(normalizeAndValidate('apiPort', '52222').value).toBe(52222)
    expect(() => normalizeAndValidate('apiPort', 'abc')).toThrow(/必须是数字/)
    expect(() => normalizeAndValidate('apiPort', 70000)).toThrow(/端口必须是 0-65535/)
    expect(() => normalizeAndValidate('proxy.checkTimeoutMs', 10)).toThrow(/>= 1000/)
  })

  it('布尔项接受 true / "true" / 1，其它一律 false', () => {
    expect(normalizeAndValidate('apiEnabled', 'true').value).toBe(true)
    expect(normalizeAndValidate('apiEnabled', 1).value).toBe(true)
    expect(normalizeAndValidate('apiEnabled', '0').value).toBe(false)
  })

  it('select 只接受白名单值', () => {
    expect(normalizeAndValidate('defaultSessionPolicy', 'clear_cookies').value).toBe('clear_cookies')
    expect(() => normalizeAndValidate('defaultSessionPolicy', 'wipe')).toThrow(/只能是/)
  })

  it('字符串项按定义校验格式', () => {
    expect(() => normalizeAndValidate('chromiumExecutable', 'relative/path')).toThrow(/绝对路径/)
    expect(normalizeAndValidate('chromiumExecutable', '/Applications/Chrome.app/Contents/MacOS/Google Chrome').value).toContain(
      '/Applications'
    )
    expect(() => normalizeAndValidate('kernelVersionCache', 'not-a-version')).toThrow(/版本号格式/)
    // 出口探测点必须支持 https：明文 http 会把「用了哪个代理 + 真实出口 IP」广播出去
    expect(normalizeAndValidate('proxy.checkUrl', 'https://example.com/json').value).toContain('https://')
    expect(normalizeAndValidate('proxy.checkUrl', 'http://ip-api.com/json').value).toContain('http://')
    expect(() => normalizeAndValidate('proxy.checkUrl', 'ftp://example.com')).toThrow(/http/)
  })

  it('检测采样次数被限制在 1-3', () => {
    expect(() => normalizeAndValidate('detectSamples', 9)).toThrow(/1-3/)
    expect(normalizeAndValidate('detectSamples', 3).value).toBe(3)
  })
})

/** 最小可用的 profile：只关心 launchArgs 如何进入命令行 */
const profile = (launchArgs: string[]): Profile => ({
  id: 'p1',
  name: 'p1',
  groupId: null,
  color: null,
  icon: null,
  note: null,
  kernel: 'chromium',
  fingerprintMode: 'auto',
  proxyMode: 'none',
  proxyId: null,
  userDataDir: '/tmp/p1',
  startupUrls: [],
  launchArgs,
  sessionPolicy: 'keep',
  retention: DEFAULT_RETENTION,
  archived: 0,
  status: 'stopped',
  openCount: 0,
  lastOpenedAt: null,
  createdAt: 0,
  updatedAt: 0,
  tags: [],
  fingerprint: null,
  proxy: null
})

describe('启动参数模板', () => {
  it('按空格切分，支持引号包裹含空格的值', () => {
    expect(parseArgsTemplate('--window-size=1280,800 --lang=en-US')).toEqual(['--window-size=1280,800', '--lang=en-US'])
    expect(parseArgsTemplate('  --a "b c"   --d="e f"  ')).toEqual(['--a', 'b c', '--d=e f'])
    expect(parseArgsTemplate('')).toEqual([])
  })

  it('托管参数不允许被模板覆盖', () => {
    expect(
      sanitizeUserArgs(['--user-data-dir=/tmp/x', '--proxy-server=http://1.2.3.4', '--disable-gpu', '--no-sandbox'])
    ).toEqual(['--disable-gpu'])
  })

  it('模板参数与环境自身参数都会进命令行，且环境参数在后', () => {
    const args = buildLaunchArgs({
      profile: profile(['--disable-features=Foo']),
      userDataDir: '/tmp/p1',
      debugPort: 9222,
      headless: true,
      templateArgs: parseArgsTemplate('--disable-gpu --use-gl=angle')
    })
    expect(args).toContain('--disable-gpu')
    expect(args).toContain('--use-gl=angle')
    expect(args).toContain('--disable-features=Foo')
    expect(args).toContain('--headless=new')
    expect(args.indexOf('--disable-features=Foo')).toBeGreaterThan(args.indexOf('--disable-gpu'))
  })

  it('模板里的托管参数被过滤，不会破坏隔离与调试', () => {
    const args = buildLaunchArgs({
      profile: profile([]),
      userDataDir: '/tmp/p1',
      debugPort: 9222,
      headless: false,
      templateArgs: parseArgsTemplate('--user-data-dir=/etc --remote-debugging-port=1 --proxy-server=http://evil')
    })
    expect(args.filter((a) => a.startsWith('--user-data-dir'))).toEqual(['--user-data-dir=/tmp/p1'])
    expect(args.filter((a) => a.startsWith('--remote-debugging-port'))).toEqual(['--remote-debugging-port=9222'])
    expect(args.some((a) => a.includes('evil'))).toBe(false)
  })

  it('默认压掉「测试版 / 建议更新」黄条，且值整体是一个参数', () => {
    const args = buildLaunchArgs({ profile: profile([]), userDataDir: '/tmp/p1', debugPort: 9222, headless: false })
    const bar = args.filter((a) => a.startsWith('--simulate-outdated-no-au'))
    expect(bar).toHaveLength(1)
    // 含空格的值必须留在同一个 argv 元素里，否则内核会把后半截当另一个参数
    expect(bar[0]).toBe(SUPPRESS_BUILD_INFOBAR)
  })

  it('--test-type 默认不开（自动化特征），显式开启才加', () => {
    const off = buildLaunchArgs({ profile: profile([]), userDataDir: '/tmp/p1', debugPort: 9222, headless: false })
    expect(off).not.toContain('--test-type')
    const on = buildLaunchArgs({
      profile: profile([]),
      userDataDir: '/tmp/p1',
      debugPort: 9222,
      headless: false,
      suppressFlagInfobar: true
    })
    expect(on).toContain('--test-type')
  })

  it('环境级 / 模板级参数都不能把黄条开关关掉', () => {
    const args = buildLaunchArgs({
      profile: profile(['--simulate-outdated-no-au=', '--test-type']),
      userDataDir: '/tmp/p1',
      debugPort: 9222,
      headless: false,
      templateArgs: parseArgsTemplate('--test-type --simulate-outdated-no-au=old')
    })
    expect(args.filter((a) => a.startsWith('--simulate-outdated-no-au'))).toHaveLength(1)
    expect(args.filter((a) => a === '--test-type')).toHaveLength(0)
  })
})

describe('内核选择', () => {
  it('findBrandedChrome 只返回真实存在的文件', () => {
    const p = findBrandedChrome()
    if (p) {
      expect(fs.existsSync(p)).toBe(true)
      expect(p).toContain('Google Chrome')
    }
  })

  it('正式版 Chrome 优先于 Playwright 缓存里的测试构建', () => {
    const branded = findBrandedChrome()
    if (!branded) return // 本机没装正式版 Chrome 时无从验证
    expect(resolveChromiumExecutable()).toBe(branded)
  })
})

describe('黄条（infobar）抑制', () => {
  const base = {
    profile: profile([]),
    userDataDir: '/tmp/p1',
    debugPort: 9222,
    headless: false
  }

  it('默认压掉「测试版 / 建议更新」黄条，且不带 --test-type', () => {
    const args = buildLaunchArgs(base)
    expect(args).toContain(SUPPRESS_BUILD_INFOBAR)
    expect(args).not.toContain('--test-type')
  })

  it('两个开关各自独立：可关掉构建提示、可打开参数提示抑制', () => {
    const off = buildLaunchArgs({ ...base, suppressBuildInfobar: false })
    expect(off.some((a) => a.startsWith('--simulate-outdated-no-au'))).toBe(false)
    const on = buildLaunchArgs({ ...base, suppressFlagInfobar: true })
    expect(on).toContain('--test-type')
  })

  it('环境级参数不能把托管的黄条开关顶掉', () => {
    const args = buildLaunchArgs({
      profile: profile(['--test-type', '--simulate-outdated-no-au=whatever']),
      userDataDir: '/tmp/p1',
      debugPort: 9222,
      headless: false
    })
    expect(args).not.toContain('--test-type')
    // 只剩应用托管的那一条，且值是我们给的
    expect(args.filter((a) => a.startsWith('--simulate-outdated-no-au'))).toEqual([SUPPRESS_BUILD_INFOBAR])
  })

  it('含空格的参数值仍是一个 argv 元素（spawn 数组形式不会被拆开）', () => {
    expect(SUPPRESS_BUILD_INFOBAR.split('=').length).toBe(2)
    expect(SUPPRESS_BUILD_INFOBAR.includes(' ')).toBe(true)
  })
})