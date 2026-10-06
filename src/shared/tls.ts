import type { DetectItem } from './detect'
import type { HttpRequestHeaders } from './http'

export type { HttpRequestHeaders }

/**
 * TLS / HTTP2 指纹的共用契约。
 *
 * 为什么必须单独做这一层：Google 与 X（前置 Cloudflare）在服务端记录
 * TLS ClientHello 与 HTTP/2 SETTINGS 的形状，并把它当作 bot score 的主要输入。
 * 这些信号在 JS 层完全不可见 —— 页面里没有任何 API 能读到自己的 ClientHello，
 * 所以只能在「连接经过我们手」的时候被动观测。
 */

export interface TlsFingerprintView {
  ja3: string
  /** JA3 的原文（点分五段），便于人工比对而不是只看到一个 md5 */
  ja3String: string
  /** 去掉 GREASE 的 JA3：Chrome 每次连接 GREASE 都变，只有这个能跨连接比对 */
  ja3Stable: string
  ja3StableString: string
  /**
   * 去 GREASE 且排序后的 JA3：跨连接唯一可比的 JA3 形态。
   * Chrome 110+ 会随机打乱扩展顺序，所以原始 JA3 每次都不同 —— 这也是
   * JA3 官方退役、业界转向 JA4 的直接原因。基线比对只用这一项或 JA4。
   */
  ja3Sorted: string
  ja3SortedString: string
  /** 去 GREASE 后的扩展线上顺序；两次观测不同 = 客户端在打乱扩展顺序（真 Chrome 会） */
  extOrder: string
  ja4: string
  /** JA4 的未哈希形态：跨环境比对时比哈希更好读 */
  ja4r: string
  versionLabel: string
  sni: string | null
  alpn: string[]
  cipherCount: number
  extensionCount: number
  /** GREASE 项数量：真实 Chrome 一定会带，伪造的 ClientHello 常常没有 */
  greaseCount: number
}

export interface Http2SettingItem {
  id: number
  value: number
}

export interface Http2Priority {
  stream: number
  parent: number
  exclusive: boolean
  weight: number
}

export interface Http2Fingerprint {
  preface: boolean
  /** SETTINGS 帧里出现的顺序（顺序本身就是指纹的一部分） */
  settings: Http2SettingItem[]
  priorities: Http2Priority[]
  /** 第一个 HEADERS 之前出现的帧类型序列 */
  preludeFrames: number[]
  /** 连接级 WINDOW_UPDATE 的增量 */
  windowUpdate: number | null
  /** 规范化字符串，跨环境比对用 */
  fp: string
}

export interface TlsObservation {
  id: string
  profileId: string
  proxyId: string | null
  host: string
  observedAt: number
  kernelVersion: string
  /** 观测方式：tap = 被动转发观测；origin = 本地 HTTPS 源服务器（能看到 H2） */
  via: 'tap' | 'origin'
  tls: TlsFingerprintView
  h2: Http2Fingerprint | null
}

export interface TlsBaseline {
  kernelVersion: string
  chromeMajor: number
  ja3: string
  /** 去 GREASE 的 JA3：跨连接唯一可比对的 JA3 形态 */
  ja3Stable: string
  /** 去 GREASE 且排序后的 JA3：Chrome 会打乱扩展顺序，只有这一项跨连接稳定 */
  ja3Sorted: string
  ja4: string
  ja4r: string
  h2fp: string | null
  cipherCount: number
  extensionCount: number
  greaseCount: number
  samples: number
  observedAt: number
}

export interface TlsProbeResult {
  profileId: string
  name: string
  at: number
  targetUrl: string
  kernelVersion: string
  observations: TlsObservation[]
  baseline: TlsBaseline | null
  /** 第三方回显服务看到的指纹（可选）：用来验证「服务端看到的」与「我们观测的」是否一致 */
  echo: EchoReport | null
  /**
   * 内核在 http/1.1 连接上实际发出的请求头（数组顺序 = 线上顺序，raw = 线上大小写）。
   * 未观测到时为 null —— 例如观测目标不可用或连接被提前关闭。
   */
  request: HttpRequestHeaders | null
  items: DetectItem[]
  ok: number
  mismatch: number
  unknown: number
  score: number
  error: string | null
}

/**
 * 回显服务（如自建 /tls/api/all）返回的指纹。
 * 它代表「服务器侧真实看到的样子」，与本机的被动观测对不上，
 * 就说明中间有设备在做 TLS 终结（代理 MITM、企业网关、杀软）。
 */
export interface EchoReport {
  url: string
  ja3: string | null
  ja4: string | null
  h2fp: string | null
  httpVersion: string | null
  raw: Record<string, unknown>
}