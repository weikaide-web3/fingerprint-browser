import { describe, it, expect } from 'vitest'
import { assertSafeId } from '../../src/main/paths'
import { buildLaunchArgs, sanitizeUserArgs } from '../../src/main/browser/args'
import { DEFAULT_RETENTION } from '@shared/session'
import type { FingerprintConfig, Profile } from '@shared/types'

/**
 * 启动参数与 id 的安全边界回归测试。
 *
 * 这两处都是「传进去就静默生效」的地方，纯功能测试看不出来：
 * - id 会被拼进 user-data-dir，而清理/崩溃恢复对该目录递归删除；
 * - fp.launch.args 若不过保留参数，能覆盖指纹层写好的 UA / 代理 / 沙箱设置。
 */

describe('assertSafeId：user-data-dir 路径穿越', () => {
  it('接受正常 id', () => {
    expect(assertSafeId('pf_0123456789abcdef0123')).toBe('pf_0123456789abcdef0123')
    expect(assertSafeId('a-b_C9')).toBe('a-b_C9')
  })

  it('拒绝路径穿越与绝对路径', () => {
    for (const bad of ['../../../../tmp/evil', '/etc', '..', '.', 'a/b', 'a\\b', '', ' ', 'x'.repeat(65)]) {
      expect(() => assertSafeId(bad), `应当拒绝 ${JSON.stringify(bad)}`).toThrow(/非法的环境 id/)
    }
  })

  it('拒绝非字符串（渲染进程可以传任意 JSON）', () => {
    for (const bad of [null, undefined, 123, {}, []] as unknown as string[]) {
      expect(() => assertSafeId(bad)).toThrow(/非法的环境 id/)
    }
  })
})

function fp(patch: Partial<FingerprintConfig['launch']> = {}): FingerprintConfig {
  const base = {
    seed: 's',
    generatedAt: 0,
    ua: { ua: 'Mozilla/5.0 (Macintosh) Chrome/140.0.0.0', browser: 'Chrome', major: '140', os: 'macOS', osVersion: '15.0' },
    clientHints: { enabled: true, brands: [], fullVersionList: [], platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm', bitness: '64', model: '', mobile: false, uaFullVersion: '140.0.0.0', wow64: false },
    screen: { width: 1512, height: 982, availWidth: 1512, availHeight: 982, availLeft: 0, availTop: 0, colorDepth: 30, pixelDepth: 30, windowWidth: 1512, windowHeight: 982, devicePixelRatio: 2, orientation: 'landscape-primary' },
    webgl: { vendor: 'Google Inc.', renderer: 'ANGLE', supportedExtensions: [], blockWebgl: false, params: {} },
    webgpu: { enabled: true, vendor: 'Google Inc.', architecture: 'Apple M1', device: '', description: '', powerPreference: 'default' },
    canvas: { noise: 1 },
    audio: { noise: 1, sampleRate: 48000, channelCount: 2 },
    fonts: { list: [] },
    webrtc: { mode: 'proxy', maskLocalIps: true, publicIp: '' },
    geolocation: { enabled: false, latitude: 0, longitude: 0, accuracy: 0, permission: 'prompt' },
    mediaDevices: { audio: [], video: [] },
    battery: { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 },
    hardware: { platform: 'macOS', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0 },
    timezone: { id: 'Asia/Tokyo', offsetMinutes: 540 },
    language: { intlLocale: 'en-US', languages: ['en-US', 'ja'] },
    headers: { extra: {} },
    storage: { quotaBytes: 0 },
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
    privacy: { doNotTrack: 'unspecified', globalPrivacyControl: false },
    plugins: { count: 0 },
    permissions: {},
    stealth: { hideWebdriver: true },
    machine: { macAddress: '' },
    performance: {},
    launch: { ignoreCertificateErrors: false, bypassCSP: false, args: [], disableFeatures: [], ...(patch as object) }
  } as unknown as FingerprintConfig
  return base
}

function profile(patch: Partial<Profile> = {}): Profile {
  return {
    id: 'pf_test',
    name: 'test',
    groupId: null,
    color: null,
    icon: null,
    note: null,
    kernel: 'chromium',
    fingerprintMode: 'auto',
    proxyMode: 'none',
    proxyId: null,
    userDataDir: '/tmp/pf_test/user-data',
    startupUrls: [],
    launchArgs: [],
    sessionPolicy: 'keep',
    retention: DEFAULT_RETENTION,
    archived: 0,
    status: 'stopped',
    openCount: 0,
    lastOpenedAt: null,
    createdAt: 1,
    updatedAt: 1,
    tags: [],
    fingerprint: fp(),
    proxy: null,
    ...patch
  }
}

describe('保留参数过滤：指纹配置段不能覆盖托管开关', () => {
  const argsOf = (p: Profile): string[] =>
    buildLaunchArgs({ profile: p, userDataDir: '/tmp/pf_test/user-data', debugPort: 9333, headless: true })

  it('launch.args 里的 --user-agent 被过滤，保留指纹层写的 UA', () => {
    const p = profile({ launchArgs: [], fingerprint: fp({ args: ['--user-agent=Evil UA'] }) })
    const args = argsOf(p)
    const uaArgs = args.filter((a) => a.startsWith('--user-agent='))
    expect(uaArgs).toHaveLength(1)
    expect(uaArgs[0]).toContain('Chrome/140')
  })

  it('launch.args 里的 --no-sandbox / --proxy-server / --remote-debugging-port 被过滤', () => {
    const p = profile({
      fingerprint: fp({
        args: ['--no-sandbox', '--proxy-server=http://evil:8080', '--remote-debugging-port=1', '--user-data-dir=/tmp/x']
      })
    })
    const args = argsOf(p)
    expect(args).not.toContain('--no-sandbox')
    expect(args.find((a) => a.startsWith('--proxy-server=http://evil'))).toBeUndefined()
    expect(args.find((a) => a.startsWith('--remote-debugging-port=1'))).toBeUndefined()
    expect(args.find((a) => a.startsWith('--user-data-dir=/tmp/x'))).toBeUndefined()
    // 托管值仍在
    expect(args).toContain('--remote-debugging-port=9333')
    expect(args.some((a) => a.startsWith('--user-data-dir=/tmp/pf_test/user-data'))).toBe(true)
  })

  it('profile.launchArgs（环境级参数）同样被过滤', () => {
    const p = profile({ launchArgs: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const args = argsOf(p)
    expect(args).not.toContain('--no-sandbox')
    expect(args).toContain('--disable-dev-shm-usage')
  })

  it('sanitizeUserArgs 对裸开关与带值形式都生效', () => {
    expect(sanitizeUserArgs(['--test-type', '--lang=fr', '--lang', '--keep-me'])).toEqual(['--keep-me'])
  })

  it('disableFeatures 被固定前缀包住，无法越权改写别的开关', () => {
    const p = profile({ fingerprint: fp({ disableFeatures: ['AutomationControlled'] }) })
    const args = argsOf(p)
    expect(args).toContain('--disable-blink-features=AutomationControlled')
    expect(args.some((a) => a === '--no-sandbox')).toBe(false)
  })

  it('不再传 --download-path（Chromium 没有这个开关，会被静默忽略）', () => {
    const args = argsOf(profile())
    expect(args.some((a) => a.startsWith('--download-path'))).toBe(false)
  })
})
