import { describe, it, expect } from 'vitest'
import { generateFingerprint, tzOffsetMinutes, createRng, pick } from '../../src/main/fingerprint/generator'

describe('指纹生成器', () => {
  it('同一 seed 必须产出完全相同的指纹（可复现）', () => {
    const a = generateFingerprint({ seed: 'seed-fixed-001' })
    const b = generateFingerprint({ seed: 'seed-fixed-001' })
    expect(a).toEqual(b)
  })

  it('不同 seed 产出的指纹不同（环境间不撞车）', () => {
    const a = generateFingerprint({ seed: 'seed-a' })
    const b = generateFingerprint({ seed: 'seed-b' })
    expect(a.ua.ua).not.toBe(b.ua.ua)
    expect(a.webgl.renderer + a.screen.width + a.timezone.id).not.toBe(
      b.webgl.renderer + b.screen.width + b.timezone.id
    )
  })

  it('UA 与 Client Hints 版本自洽', () => {
    const fp = generateFingerprint({ seed: 'consistency-1', kernelVersion: '153.0.8010.12' })
    expect(fp.ua.major).toBe(153)
    expect(fp.ua.ua).toContain('Chrome/153.0.8010.12')
    expect(fp.clientHints.uaFullVersion).toBe('153.0.8010.12')
    for (const brand of fp.clientHints.brands) {
      if (brand.brand === 'Chromium' || brand.brand === 'Google Chrome') expect(brand.version).toBe('153')
    }
  })

  it('UA 平台与 GPU / 字体 / Client Hints 平台自洽', () => {
    const mac = generateFingerprint({ seed: 'mac-1', os: 'macOS' })
    expect(mac.ua.ua).toContain('Macintosh')
    expect(mac.clientHints.platform).toBe('macOS')
    expect(mac.hardware.platform).toBe('macOS')
    expect(mac.webgl.renderer).not.toContain('Direct3D')

    const win = generateFingerprint({ seed: 'win-1', os: 'Windows' })
    expect(win.ua.ua).toContain('Windows NT')
    expect(win.clientHints.platform).toBe('Windows')
    expect(win.hardware.platform).toBe('Win32')
  })

  it('WebGL 与 WebGPU 必须描述同一块显卡（多开也不能打脸）', () => {
    const family = (v: string): string[] =>
      ['apple', 'nvidia', 'amd', 'intel', 'imagination', 'qualcomm'].filter((n) => v.toLowerCase().includes(n))
    for (let i = 0; i < 30; i++) {
      const fp = generateFingerprint({ seed: `gpu-${i}`, os: i % 2 === 0 ? 'macOS' : 'Windows' })
      const gl = family(`${fp.webgl.vendor} ${fp.webgl.renderer}`)
      const gpu = family(fp.webgpu.vendor)
      expect(gl.length, `seed gpu-${i} 的 WebGL 厂商无法识别：${fp.webgl.vendor}`).toBeGreaterThan(0)
      expect(gpu.length, `seed gpu-${i} 的 WebGPU 厂商无法识别：${fp.webgpu.vendor}`).toBeGreaterThan(0)
      expect(gl.some((f) => gpu.includes(f)), `seed gpu-${i}: WebGL=${fp.webgl.vendor} 与 WebGPU=${fp.webgpu.vendor} 不同源`).toBe(true)
    }
  })

  it('屏幕尺寸自洽：可用区域不大于物理分辨率', () => {
    for (let i = 0; i < 30; i++) {
      const fp = generateFingerprint({ seed: `screen-${i}` })
      expect(fp.screen.availWidth).toBeLessThanOrEqual(fp.screen.width)
      expect(fp.screen.availHeight).toBeLessThanOrEqual(fp.screen.height)
      expect(fp.screen.windowWidth).toBeLessThanOrEqual(fp.screen.width)
      expect(fp.screen.windowHeight).toBeLessThanOrEqual(fp.screen.availHeight)
    }
  })

  it('时区偏移计算正确（含夏令时）', () => {
    const summer = new Date(Date.UTC(2026, 6, 1)) // 7 月
    const winter = new Date(Date.UTC(2026, 0, 15)) // 1 月
    expect(tzOffsetMinutes('America/Los_Angeles', summer)).toBe(-420)
    expect(tzOffsetMinutes('America/Los_Angeles', winter)).toBe(-480)
    expect(tzOffsetMinutes('Asia/Shanghai', summer)).toBe(480)
  })

  it('PRNG 稳定：同一 seed 的随机序列一致', () => {
    const r1 = createRng('abc')
    const r2 = createRng('abc')
    const s1 = Array.from({ length: 20 }, () => r1())
    const s2 = Array.from({ length: 20 }, () => r2())
    expect(s1).toEqual(s2)
  })

  it('批量生成的指纹彼此不同（多开场景）', () => {
    const set = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const fp = generateFingerprint({ seed: `bulk-${i}` })
      set.add(
        [fp.ua.ua, fp.webgl.renderer, fp.screen.width, fp.timezone.id, fp.hardware.hardwareConcurrency].join('|')
      )
    }
    expect(set.size).toBeGreaterThan(40)
  })

  it('pick 在空数组上不会崩溃（防御性）', () => {
    const rng = createRng('x')
    expect(() => pick(rng, [1])).not.toThrow()
  })
})
