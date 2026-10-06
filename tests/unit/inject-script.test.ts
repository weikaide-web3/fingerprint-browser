import { describe, it, expect } from 'vitest'
import { buildFingerprintScript } from '../../src/main/fingerprint/script'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import type { FingerprintConfig } from '@shared/fingerprint'

/**
 * 注入脚本自身的健壮性测试。
 *
 * 补丁全部是用模板字符串拼出来的 JS，这类代码有个经典陷阱：
 * 正则里的 \s、\( 写在模板字符串里会被转义吃掉，生成的脚本于是带上一条
 * 残缺正则 —— 整个 IIFE 解析失败，所有指纹补丁静默失效，
 * 而界面上一切正常，只有真实内核里的信号是裸的。
 * 所以这里必须真的把生成的脚本交给 JS 引擎解析一次。
 */

const configs: FingerprintConfig[] = [
  generateFingerprint({ seed: 'script-macos', os: 'macOS', locale: 'en-US', timezone: 'America/New_York' }),
  generateFingerprint({ seed: 'script-win', os: 'Windows', locale: 'zh-CN', timezone: 'Asia/Shanghai' }),
  generateFingerprint({ seed: 'script-linux', os: 'Linux', locale: 'de-DE', timezone: 'Europe/Berlin' })
]

describe('注入脚本可解析性', () => {
  it('每种配置生成的脚本都能被 JS 引擎解析', () => {
    for (const fp of configs) {
      const src = buildFingerprintScript(fp)
      expect(src.length, `${fp.seed} 的脚本为空`).toBeGreaterThan(1000)
      // new Function 只做解析，不执行，因此不需要 DOM
      expect(() => new Function(src), `${fp.seed} 的注入脚本语法有误`).not.toThrow()
    }
  })

  it('正则里的反斜杠不会被模板字符串吃掉', () => {
    const src = buildFingerprintScript(configs[0])
    // 这些是补丁里真实存在的正则；单反斜杠被吃掉后会出现 "s+ands+" 这类残骸
    expect(src).toContain(String.raw`/\s+and\s+/`)
    expect(src).toContain(String.raw`/\bor\b/`)
    expect(src).toContain(String.raw`not\s*\(`)
    expect(src).not.toContain('s+ands+')
  })

  it('带幂等守卫，重复注册不会叠加噪声', () => {
    const src = buildFingerprintScript(configs[0])
    expect(src).toContain('__fpInjected')
  })

  it('暴露被改写函数的清单，供检测页逐个验证 native 伪装', () => {
    const src = buildFingerprintScript(configs[0])
    expect(src).toContain('__fpbPatched')
    expect(src).toContain('patchedNames')
  })

  it('define 失败会留痕，不会静默改到错误的原型', () => {
    const src = buildFingerprintScript(configs[0])
    expect(src).toContain('fpb.define.errors')
  })

  it('同一配置两次生成的脚本逐字节一致（噪声不漂移）', () => {
    const fp = generateFingerprint({ seed: 'script-deterministic' })
    expect(buildFingerprintScript(fp)).toBe(buildFingerprintScript(fp))
  })

  it('旧库里的残缺配置也能生成可解析脚本（normalizeFingerprint 兜底）', () => {
    const partial = { seed: 'legacy', ua: { ua: 'Mozilla/5.0' } } as unknown as FingerprintConfig
    const src = buildFingerprintScript(partial)
    expect(() => new Function(src)).not.toThrow()
  })
})