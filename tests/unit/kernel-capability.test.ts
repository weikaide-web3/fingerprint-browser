import { describe, it, expect } from 'vitest'
import { classify, MARKER_GLOBAL, PATCHED_BUNDLE_PREFIX } from '../../src/main/kernel/identity'
import { buildGapReport, exploitableGaps } from '../../src/main/kernel/capability'
import type { KernelIdentity } from '@shared/kernel'

/**
 * 内核能力矩阵单测。
 *
 * 这一层的意义是「把 JS 注入保护不到的地方摊开」，所以断言的重点不是分数，
 * 而是：换内核后状态必须变、补丁内核必须把内核级向量升级为已覆盖、
 * 以及「服务端可复核 + 未覆盖」必须能被单独列出来。
 */

function identityOf(patchLevel: number, branded: boolean, version = '153.0.8010.12'): KernelIdentity {
  return {
    path: '/tmp/Chrome',
    flavor: patchLevel > 0 ? 'patched' : branded ? 'branded-chrome' : 'chromium',
    version,
    major: Number(version.split('.')[0]),
    branded,
    patched: patchLevel > 0,
    patchLevel,
    marker: patchLevel > 0 ? `${MARKER_GLOBAL} level=${patchLevel}` : null,
    source: 'playwright',
    bundleName: branded ? 'Google Chrome' : 'Chromium',
    bundleId: patchLevel > 0 ? `${PATCHED_BUNDLE_PREFIX}.chrome` : 'org.chromium.Chromium'
  }
}

describe('内核身份判定', () => {
  it('正式版 Chrome 判定为 branded-chrome', () => {
    const r = classify(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'Google Chrome',
      'com.google.Chrome'
    )
    expect(r).toEqual({ flavor: 'branded-chrome', branded: true, patched: false })
  })

  it('Chrome for Testing 不算品牌化（缺 Widevine / 专有编解码）', () => {
    const r = classify(
      '/x/chromium-1243/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Google Chrome for Testing',
      'com.google.Chrome.for.testing'
    )
    expect(r.flavor).toBe('chrome-for-testing')
    expect(r.branded).toBe(false)
  })

  it('自己的补丁内核按 bundle id 前缀识别，优先级最高', () => {
    const r = classify('/opt/fpb-chrome/Chrome', 'FingerprintBrowser Chrome', `${PATCHED_BUNDLE_PREFIX}.chrome`)
    expect(r).toEqual({ flavor: 'patched', branded: false, patched: true })
  })

  it('认不出来时返回 unknown，而不是假装是 Chrome', () => {
    expect(classify('/opt/weird/browser', 'Weird', 'com.weird').flavor).toBe('unknown')
  })
})

describe('内核能力矩阵', () => {
  it('官方未品牌化内核：媒体能力降级，且给出切正式版的具体建议', () => {
    const r = buildGapReport(identityOf(0, false))
    const media = r.items.find((i) => i.key === 'media.codecs')!
    expect(media.status).toBe('partial')
    expect(r.advice).toContain('正式版')
    expect(r.verdict).not.toBe('kernel-hardened')
  })

  it('正式版 Chrome：媒体能力回到已覆盖', () => {
    const r = buildGapReport(identityOf(0, true))
    expect(r.items.find((i) => i.key === 'media.codecs')!.status).toBe('covered')
  })

  it('补丁内核把内核级向量升级为已覆盖，并判定为 kernel-hardened', () => {
    const r = buildGapReport(identityOf(2, false))
    expect(r.verdict).toBe('kernel-hardened')
    for (const key of ['render.pipeline', 'fonts.metrics', 'native.toString', 'automation.cdp', 'tls.clientHello', 'http2.settings']) {
      expect(r.items.find((i) => i.key === key)!.status, `${key} 应当已被内核层覆盖`).toBe('covered')
    }
    expect(r.coverage).toBeGreaterThan(buildGapReport(identityOf(0, true)).coverage)
  })

  it('官方内核下 TLS / H2 / 渲染管线必须出现在「可被利用」清单里', () => {
    const r = buildGapReport(identityOf(0, true))
    const gaps = exploitableGaps(r)
    const keys = gaps.map((g) => g.key)
    expect(keys).toContain('tls.clientHello')
    expect(keys).toContain('http2.settings')
    expect(keys).toContain('render.pipeline')
    // 已覆盖的项不能混进来
    expect(keys).not.toContain('clock.integrity')
    expect(keys).not.toContain('ip.quality')
    // 清单里每一项都必须同时满足「服务端可复核」与「未覆盖」
    for (const g of gaps) {
      expect(g.serverVerifiable).toBe(true)
      expect(g.status).not.toBe('covered')
    }
  })

  it('刻意不改时钟：这一项必须标为已覆盖且被 X 使用', () => {
    const r = buildGapReport(identityOf(0, true))
    const clock = r.items.find((i) => i.key === 'clock.integrity')!
    expect(clock.status).toBe('covered')
    expect(clock.usedBy).toContain('x')
  })

  it('统计自洽：三类状态之和 = 总项数，coverage 在 0-100', () => {
    for (const id of [identityOf(0, false), identityOf(0, true), identityOf(3, false)]) {
      const r = buildGapReport(id)
      expect(r.covered + r.partial + r.kernelOnly).toBe(r.items.length)
      expect(r.coverage).toBeGreaterThanOrEqual(0)
      expect(r.coverage).toBeLessThanOrEqual(100)
      expect(r.coverage).toBe(Math.round((r.covered / r.items.length) * 100))
      // 每个向量都要有可解释的说明，且 key 唯一
      expect(new Set(r.items.map((i) => i.key)).size).toBe(r.items.length)
      for (const i of r.items) {
        expect(i.detail.length).toBeGreaterThan(10)
        if (i.status !== 'covered') expect(i.action, `${i.key} 未覆盖却没给处置建议`).toBeTruthy()
      }
    }
  })

  it('版本号读不到时 UA 一致性降级为部分覆盖', () => {
    const r = buildGapReport({ ...identityOf(0, true), version: 'unknown', major: null })
    expect(r.items.find((i) => i.key === 'ua.coherence')!.status).toBe('partial')
  })
})