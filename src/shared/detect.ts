/** 指纹检测（真实信号回传 + 与 profile 期望逐项比对）的共用契约 */

import type { KernelIdentity } from './kernel'

export type DetectStatus = 'ok' | 'mismatch' | 'unknown'

export interface DetectItem {
  /** 稳定标识，如 webgl.vendor */
  key: string
  /** 界面展示名 */
  label: string
  /** 分组：UA / 屏幕 / WebGL ... */
  group: string
  /** profile 里的期望值；无法从配置推导时为 '—' */
  expected: string
  /** 内核里实测到的值 */
  actual: string
  status: DetectStatus
  note?: string
}

export interface DetectReport {
  profileId: string
  name: string
  collectedAt: number
  /** 采样次数：>=2 才能验证噪声稳定性 */
  samples: number
  items: DetectItem[]
  ok: number
  mismatch: number
  unknown: number
  /** 0-100：ok / (ok + mismatch) */
  score: number
  /** 原始实测信号（第一次采样），便于排查 */
  snapshot: Record<string, unknown>
  error: string | null
  /** 本次采样所用的内核身份（含补丁内核标记），用于解释「为什么这项做不到」 */
  kernel: KernelIdentity | null
}