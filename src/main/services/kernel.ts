import { kernelIdentity } from '../kernel/identity'
import { buildGapReport, exploitableGaps } from '../kernel/capability'
import { findBrandedChrome } from '../browser/executable'
import { setTypedSetting, typedSetting } from '../settings/defs'
import { log } from '../lib/log'
import type { KernelIdentity, KernelReportView } from '@shared/kernel'

/**
 * 内核层能力与剩余风险的对外服务。
 *
 * 之所以要有这一层，是因为注入层的能力有边界：ClientHello、渲染管线、
 * 字体 shaping、Widevine 这些都在内核里，JS 改不动。与其让用户以为
 * 「检测 100 分 = 安全」，不如把剩余风险量化并给出可执行动作。
 */

export type KernelReport = KernelReportView

export function identity(): KernelIdentity {
  return kernelIdentity()
}

export function report(): KernelReport {
  const id = kernelIdentity()
  const base = buildGapReport(id)
  return {
    ...base,
    exploitable: exploitableGaps(base),
    brandedAvailable: findBrandedChrome(),
    preferBranded: typedSetting<boolean>('preferBrandedChrome', true)
  }
}

/**
 * 一键切到本机正式版 Chrome。
 * 写的是「自定义内核路径」而不是改 preferBrandedChrome：这样即使将来
 * 又装了别的 Playwright 内核，也不会被解析顺序悄悄换回去。
 */
export function useBrandedChrome(): { path: string; previous: string } {
  const branded = findBrandedChrome()
  if (!branded) throw new Error('本机没有找到正式版 Chrome（/Applications/Google Chrome.app）')
  const previous = String(typedSetting<string>('chromiumExecutable', ''))
  setTypedSetting('chromiumExecutable', branded)
  log('kernel', `内核切换为正式版 Chrome：${branded}（原：${previous || '自动'}）`)
  return { path: branded, previous }
}

/** 取消自定义内核，回到「优先正式版 Chrome，否则 Playwright 内核」的自动顺序 */
export function clearOverride(): KernelIdentity {
  setTypedSetting('chromiumExecutable', '')
  log('kernel', '已取消自定义内核路径，恢复自动解析')
  return identity()
}

export function setPreferBranded(on: boolean): KernelIdentity {
  setTypedSetting('preferBrandedChrome', on)
  return identity()
}