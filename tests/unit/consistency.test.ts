import { describe, it, expect } from 'vitest'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { validateFingerprint, blockingIssues, majorOf } from '../../src/main/fingerprint/consistency'
import type { FingerprintConfig } from '../../src/shared/types'

/** 拿一份干净的 macOS 指纹，再按用例局部破坏 */
function clean(patch?: (fp: FingerprintConfig) => void): FingerprintConfig {
  const fp = generateFingerprint({ seed: 'consistency-base', os: 'macOS', kernelVersion: '153.0.8010.12' })
  patch?.(fp)
  return fp
}

const codesOf = (fp: FingerprintConfig): string[] => validateFingerprint(fp).issues.map((i) => i.code)

describe('指纹一致性体检', () => {
  it('生成器产出的指纹必须零问题（体检满分）', () => {
    for (let i = 0; i < 24; i++) {
      const fp = generateFingerprint({ seed: `clean-${i}`, os: i % 2 === 0 ? 'macOS' : 'Windows' })
      const report = validateFingerprint(fp)
      expect(report.issues, JSON.stringify(report.issues)).toEqual([])
      expect(report.score).toBe(100)
    }
  })

  it('UA 与 Client Hints 版本不一致要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.clientHints.uaFullVersion = '150.0.0.0')))
    expect(codes).toContain('CH_FULL_VERSION')
    expect(codes).toContain('CH_FULL_VERSION_LIST')
  })

  it('Client Hints 大版本与 UA 对不上要报 error', () => {
    const codes = codesOf(
      clean((fp) => {
        fp.clientHints.brands = fp.clientHints.brands.map((b) => ({ ...b, version: '99' }))
      })
    )
    expect(codes).toContain('CH_BRANDS_MAJOR')
  })

  it('sec-ch-ua-platform 与 UA 系统不一致要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.clientHints.platform = 'Windows')))
    expect(codes).toContain('CH_PLATFORM')
  })

  it('navigator.platform 与 UA 系统不一致要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.hardware.platform = 'Win32')))
    expect(codes).toContain('HW_PLATFORM')
  })

  it('UA 字符串与声明的系统不匹配要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.ua.ua = fp.ua.ua.replace('Macintosh', 'Windows NT'))))
    expect(codes).toContain('UA_OS')
  })

  it('UA 大版本与完整版本不一致要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.ua.major = 120)))
    expect(codes).toContain('UA_MAJOR')
    expect(codes).toContain('CH_BRANDS_MAJOR')
  })

  it('屏幕可用区域大于物理分辨率要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.screen.availHeight = fp.screen.height + 100)))
    expect(codes).toContain('SCREEN_AVAIL')
  })

  it('窗口大于可用区域要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.screen.windowHeight = fp.screen.availHeight + 1)))
    expect(codes).toContain('SCREEN_WINDOW')
  })

  it('屏幕方向与宽高矛盾要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.screen.orientationType = 'portrait-primary')))
    expect(codes).toContain('SCREEN_ORIENTATION')
  })

  it('macOS 指纹带 Windows GPU（Direct3D）要报 error', () => {
    const codes = codesOf(
      clean((fp) => {
        fp.webgl.vendor = 'Google Inc. (NVIDIA)'
        fp.webgl.renderer = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
      })
    )
    expect(codes).toContain('WEBGL_GPU_OS')
  })

  it('Windows 指纹带 Mac GPU 要报 error', () => {
    const win = generateFingerprint({ seed: 'win-bad-gpu', os: 'Windows' })
    win.webgl.vendor = 'Apple Inc.'
    win.webgl.renderer = 'Apple M2'
    expect(codesOf(win)).toContain('WEBGL_GPU_OS')
  })

  it('数据集里的 macOS Intel GPU 预设不能被误判', () => {
    const fp = clean((f) => {
      f.webgl.vendor = 'Google Inc. (Intel)'
      f.webgl.renderer = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E98) OpenGL ES 2.0 macOS - 21.0.6, OpenGL)'
    })
    expect(codesOf(fp)).not.toContain('WEBGL_GPU_OS')
  })

  it('时区偏移过期（跨夏令时）要报 error', () => {
    const fp = clean()
    fp.timezone.id = 'America/Los_Angeles'
    fp.timezone.offsetMinutes = -480 // 冬令时
    fp.geolocation.timezoneId = 'America/Los_Angeles'
    const summer = validateFingerprint(fp, { at: new Date(Date.UTC(2026, 6, 1)) })
    const winter = validateFingerprint(fp, { at: new Date(Date.UTC(2026, 0, 15)) })
    expect(summer.issues.map((i) => i.code)).toContain('TZ_OFFSET')
    expect(winter.issues.map((i) => i.code)).not.toContain('TZ_OFFSET')
  })

  it('地理位置时区与指纹时区不一致要报 error', () => {
    const codes = codesOf(clean((fp) => (fp.geolocation.timezoneId = 'Asia/Tokyo')))
    expect(codes).toContain('GEO_TZ')
  })

  it('代理出口时区与指纹时区不一致要报 warn', () => {
    const report = validateFingerprint(clean(), { proxyTimezone: 'Asia/Tokyo' })
    expect(report.issues.find((i) => i.code === 'PROXY_TZ')?.level).toBe('warn')
  })

  it('WebRTC 公网 IP 与代理出口不一致要报 warn', () => {
    const fp = clean()
    fp.webrtc.publicIp = '198.51.100.9'
    const report = validateFingerprint(fp, { proxyIp: '203.0.113.77' })
    expect(report.issues.find((i) => i.code === 'WEBRTC_IP')?.level).toBe('warn')
    fp.webrtc.publicIp = '203.0.113.77'
    const ok = validateFingerprint(fp, { proxyIp: '203.0.113.77' })
    expect(ok.issues.map((i) => i.code)).not.toContain('WEBRTC_IP')
  })

  it('deviceMemory / 触屏 / 字体等可疑组合要报 warn', () => {
    const codes = codesOf(
      clean((fp) => {
        fp.hardware.deviceMemory = 3
        fp.hardware.maxTouchPoints = 5
        fp.fonts.mode = 'custom'
        fp.fonts.families = ['Segoe UI', 'Helvetica Neue']
      })
    )
    expect(codes).toContain('HW_MEMORY')
    expect(codes).toContain('HW_TOUCH')
    expect(codes).toContain('FONTS_OS')
  })

  it('语言不一致要报 warn', () => {
    const codes = codesOf(
      clean((fp) => {
        fp.language.languages = ['de-DE', 'de']
        fp.language.acceptLanguage = 'fr-FR,fr;q=0.9'
        fp.language.intlLocale = 'en-US'
      })
    )
    expect(codes).toContain('LANG_ACCEPT')
    expect(codes).toContain('LANG_INTL')
  })

  it('屏蔽 WebGL 却开 WebGPU 要报 warn，屏蔽 WebGL 本身给 info', () => {
    const report = validateFingerprint(clean((fp) => (fp.webgl.blockWebgl = true)))
    expect(report.issues.find((i) => i.code === 'WEBGL_WEBGPU_CONFLICT')?.level).toBe('warn')
    expect(report.issues.find((i) => i.code === 'WEBGL_BLOCKED')?.level).toBe('info')
  })

  it('WebGPU 与 WebGL 不是同一块显卡要报 error', () => {
    const fp = clean((f) => {
      f.webgl.vendor = 'Apple Inc.'
      f.webgl.renderer = 'Apple M1'
      f.webgpu.enabled = true
      f.webgpu.vendor = 'nvidia'
      f.webgpu.architecture = 'ampere'
    })
    const issue = validateFingerprint(fp).issues.find((i) => i.code === 'WEBGPU_GL_CONFLICT')
    expect(issue?.level).toBe('error')
    expect(issue?.fields).toEqual(['webgpu.vendor', 'webgl.vendor'])
    // 同源之后就消失
    const same = clean((f) => {
      f.webgl.vendor = 'Apple Inc.'
      f.webgl.renderer = 'Apple M1'
      f.webgpu.vendor = 'apple'
      f.webgpu.architecture = 'apple-m1'
    })
    expect(codesOf(same)).not.toContain('WEBGPU_GL_CONFLICT')
  })

  it('WebGPU 厂商与操作系统常见厂商不符要报 warn', () => {
    const fp = clean((f) => {
      f.webgpu.vendor = 'qualcomm'
      f.webgl.vendor = 'Google Inc. (Qualcomm)'
      f.webgl.renderer = 'ANGLE (Qualcomm, Adreno (TM) 640 OpenGL ES)'
    })
    expect(codesOf(fp)).toContain('WEBGPU_VENDOR')
  })

  it('得分随问题严重度下降，且不会低于 0', () => {
    const cleanReport = validateFingerprint(clean())
    const oneError = validateFingerprint(clean((fp) => (fp.screen.availHeight = fp.screen.height + 1)))
    const manyErrors = validateFingerprint(
      clean((fp) => {
        fp.screen.availHeight = fp.screen.height + 1
        fp.hardware.platform = 'Win32'
        fp.clientHints.platform = 'Windows'
        fp.clientHints.uaFullVersion = '1.0.0.0'
        fp.geolocation.timezoneId = 'Asia/Tokyo'
        fp.timezone.offsetMinutes = 12345
        fp.ua.major = 1
        fp.ua.ua = 'bogus'
      })
    )
    expect(cleanReport.score).toBe(100)
    expect(oneError.score).toBe(88)
    expect(manyErrors.score).toBe(0)
  })

  it('每个问题都能定位到具体字段', () => {
    const report = validateFingerprint(clean((fp) => (fp.hardware.deviceMemory = 3)))
    expect(report.issues.find((i) => i.code === 'HW_MEMORY')?.fields).toEqual(['hardware.deviceMemory'])
  })
})

describe('UA 声明版本 vs 真实内核版本', () => {
  const KERNEL = '153.0.8010.12'

  /** 把整份指纹的声明版本整体换到另一个版本，保证 UA/CH 内部仍然自洽 */
  function retarget(fp: FingerprintConfig, version: string): void {
    const oldFull = fp.ua.version
    const major = Number(version.split('.')[0])
    fp.ua.major = major
    fp.ua.version = version
    fp.ua.ua = fp.ua.ua.replace(`Chrome/${oldFull}`, `Chrome/${version}`)
    fp.clientHints.uaFullVersion = version
    fp.clientHints.brands = fp.clientHints.brands.map((b) => ({ ...b, version: String(major) }))
    fp.clientHints.fullVersionList = fp.clientHints.fullVersionList.map((b) => ({ ...b, version }))
  }

  it('版本一致时不产生任何问题', () => {
    const report = validateFingerprint(clean(), { kernelVersion: KERNEL })
    expect(report.issues.filter((i) => i.code.startsWith('UA_KERNEL'))).toEqual([])
    expect(report.score).toBe(100)
  })

  it('声明比内核新 → error（TLS/媒体能力必然对不上）', () => {
    const fp = clean((f) => retarget(f, '170.0.8500.0'))
    const report = validateFingerprint(fp, { kernelVersion: KERNEL })
    const issue = report.issues.find((i) => i.code === 'UA_KERNEL_NEWER')
    expect(issue?.level).toBe('error')
    expect(issue?.message).toContain('170')
    expect(blockingIssues(report).map((i) => i.code)).toContain('UA_KERNEL_NEWER')
  })

  it('落后 1-2 个大版本 → 只警告，不阻断保存', () => {
    const fp = clean((f) => retarget(f, '151.0.7922.70'))
    const report = validateFingerprint(fp, { kernelVersion: KERNEL })
    expect(report.issues.find((i) => i.code === 'UA_KERNEL_MINOR_DRIFT')?.level).toBe('warn')
    expect(blockingIssues(report)).toEqual([])
  })

  it('落后过多 → error 并列入硬伤', () => {
    const fp = clean((f) => retarget(f, '120.0.6099.130'))
    const report = validateFingerprint(fp, { kernelVersion: KERNEL })
    expect(report.issues.find((i) => i.code === 'UA_KERNEL_DRIFT')?.level).toBe('error')
    expect(blockingIssues(report).map((i) => i.code)).toContain('UA_KERNEL_DRIFT')
  })

  it('不传内核版本时跳过该项（体检仍可离线运行）', () => {
    expect(validateFingerprint(clean()).issues.filter((i) => i.code.startsWith('UA_KERNEL'))).toEqual([])
  })

  it('内核版本号写坏时给出可定位的警告', () => {
    const report = validateFingerprint(clean(), { kernelVersion: 'nightly-build' })
    expect(report.issues.find((i) => i.code === 'KERNEL_VERSION_PARSE')?.fields).toEqual(['kernelVersion'])
  })

  it('Firefox / Safari 不发送 sec-ch-ua，不做内核版本比对', () => {
    const fp = clean((f) => {
      f.ua.browser = 'Firefox'
      f.ua.version = '130.0'
      f.ua.major = 130
      f.ua.ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0'
      f.clientHints.enabled = false
    })
    expect(validateFingerprint(fp, { kernelVersion: KERNEL }).issues.filter((i) => i.code.startsWith('UA_KERNEL'))).toEqual([])
  })

  it('majorOf 容错', () => {
    expect(majorOf('153.0.8010.12')).toBe(153)
    expect(majorOf(' 132 ')).toBe(132)
    expect(majorOf('')).toBeNull()
    expect(majorOf(null)).toBeNull()
    expect(majorOf('beta')).toBeNull()
  })
})

