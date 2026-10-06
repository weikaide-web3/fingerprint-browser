/**
 * 内核层能力与剩余风险的共用契约。
 *
 * 为什么需要这一层：JS 注入能改的是「页面读到的值」，改不了「内核自己的行为」。
 * Google 的 BotGuard 与 X 前置的 CDN bot 管理都会做内核级验证（渲染管线、
 * 事件时序、native 完整性、ClientHello），这些是 JS 层无法触及的。
 * 与其假装注入层万能，不如把「哪些信号仍然只有 JS 层保护」明确列出来。
 */

export type KernelFlavor = 'branded-chrome' | 'chrome-for-testing' | 'chromium' | 'patched' | 'unknown'

/** 内核可执行文件的来源，用于解释「为什么用的是这个内核」 */
export type KernelSource = 'setting' | 'branded' | 'playwright' | 'cache' | 'none'

export interface KernelIdentity {
  path: string
  flavor: KernelFlavor
  /** 版本号；读不到时为 'unknown' */
  version: string
  major: number | null
  /** 是否品牌化正式版（有 Widevine / H.264 / 官方更新通道） */
  branded: boolean
  /** 是否我们自己编译的补丁内核 */
  patched: boolean
  /** 补丁级别：0 = 官方内核，>=1 = 已带内核层补丁 */
  patchLevel: number
  /** 补丁构建在页面里暴露的标记（window.__fpbKernel），官方内核为 null */
  marker: string | null
  source: KernelSource
  bundleName: string
  bundleId: string
}

/** 一个检测向量的实现层次 */
export type VectorLayer = 'js' | 'network' | 'kernel'
export type VectorStatus = 'covered' | 'partial' | 'kernel-only'

export interface KernelGapItem {
  key: string
  label: string
  layer: VectorLayer
  status: VectorStatus
  /** 服务端有没有办法用内核级手段复核这一项 */
  serverVerifiable: boolean
  /** 哪家在用（决定优先级） */
  usedBy: ('google' | 'x')[]
  detail: string
  /** 需要内核层才能彻底解决时给出可执行动作 */
  action?: string
}

export interface KernelGapReport {
  identity: KernelIdentity
  items: KernelGapItem[]
  covered: number
  partial: number
  kernelOnly: number
  /** 0-100：JS/网络层已覆盖的比例（越高越好，但到不了 100） */
  coverage: number
  /** 结论：这个内核在当前形态下能不能扛内核级验证 */
  verdict: 'js-only' | 'partially-hardened' | 'kernel-hardened'
  advice: string
}

/** 给界面用：报告 + 可直接执行的处置信息 */
export interface KernelReportView extends KernelGapReport {
  /** 服务端可复核且尚未覆盖的项：真正会被打穿的口子 */
  exploitable: KernelGapItem[]
  /** 本机可用的正式版 Chrome 路径；没有则为 null */
  brandedAvailable: string | null
  /** 设置项 preferBrandedChrome */
  preferBranded: boolean
}