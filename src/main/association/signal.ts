import { createHash } from 'node:crypto'
import type { FingerprintConfig } from '@shared/fingerprint'

/**
 * 指纹「关键信号摘要」。
 *
 * 为什么不只比对 seed：两个环境可以 seed 不同、但因为都用了同一套默认值
 * （或同一次克隆）而暴露完全相同的 UA / 屏幕 / WebGL / 时区 / 语言。
 * 服务端比对的是这些信号本身，不是我们的 seed，所以摘要也必须按信号算。
 *
 * 刻意不含 seed 与噪声参数：那两个是我们内部的实现细节，
 * 网站看不到；把它们放进摘要会让「噪声不同」掩盖「信号相同」。
 */
export function signalKeyOf(fp: FingerprintConfig | null): string | null {
  if (!fp) return null
  const parts = [
    fp.ua.ua,
    fp.hardware.platform,
    `${fp.hardware.hardwareConcurrency}/${fp.hardware.deviceMemory}/${fp.hardware.maxTouchPoints}`,
    `${fp.screen.width}x${fp.screen.height}@${fp.screen.devicePixelRatio}`,
    `${fp.screen.colorDepth}/${fp.screen.pixelDepth}`,
    fp.timezone.id,
    fp.language.languages.join(','),
    fp.language.intlLocale,
    `${fp.webgl.vendor}|${fp.webgl.renderer}|${fp.webgl.version}`,
    String(fp.webgl.extensions.length),
    fp.clientHints.enabled ? fp.clientHints.brands.map((b) => `${b.brand}:${b.version}`).join(',') : 'no-ch',
    fp.ua.os,
    fp.ua.major
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}