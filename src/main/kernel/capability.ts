import type { KernelGapItem, KernelGapReport, KernelIdentity } from '@shared/kernel'

/**
 * 内核层能力矩阵（纯函数）。
 *
 * 这一层的目的不是加分，而是把「JS 注入保护不到的地方」摊开：
 * Google 的 BotGuard 与 X 前置的 CDN bot 管理都会做内核级验证，
 * 只靠 JS 补丁永远到不了 100 分。把盲区量化，用户才知道该不该
 * 换正式版 Chrome / 自建内核 / 换住宅 IP。
 */

type UsedBy = ('google' | 'x')[]

interface VectorDef {
  key: string
  label: string
  layer: KernelGapItem['layer']
  /** 默认状态；identity 相关项会在 resolve 里调整 */
  base: KernelGapItem['status']
  serverVerifiable: boolean
  usedBy: UsedBy
  detail: string
  action?: string
}

const VECTORS: VectorDef[] = [
  {
    key: 'ua.coherence',
    label: 'UA / Client Hints / TLS 三者版本一致',
    layer: 'network',
    base: 'partial',
    serverVerifiable: true,
    usedBy: ['google', 'x'],
    detail: 'UA 与 Client Hints 由 auto 模式对齐（已解决），但 TLS 形状由内核版本决定：三者必须同源才不被判矛盾。',
    action: '保持 UA 主版本 = 内核实测版本；换内核后重新采集基线'
  },
  {
    key: 'tls.clientHello',
    label: 'TLS ClientHello（JA3/JA4）',
    layer: 'network',
    base: 'partial',
    serverVerifiable: true,
    usedBy: ['google', 'x'],
    detail: '已能被动观测并与基线比对，但 JS 层无法改写 ClientHello。观测只能发现问题，不能修问题。',
    action: '用带 TLS 形状控制的前置代理，或自编译内核替换 BoringSSL 的 Hello 配置'
  },
  {
    key: 'http2.settings',
    label: 'HTTP/2 SETTINGS 与帧顺序',
    layer: 'network',
    base: 'partial',
    serverVerifiable: true,
    usedBy: ['x'],
    detail: 'X 前置的 CDN bot 管理把 H2 形状当作主要输入。同样是「能观测、不能改」。',
    action: '同上：前置代理层或内核层'
  },
  {
    key: 'ip.quality',
    label: '出口 IP 质量（hosting/mobile/residential）',
    layer: 'network',
    base: 'covered',
    serverVerifiable: true,
    usedBy: ['google', 'x'],
    detail: '已判定 usageType / hosting / proxy / mobile 并在 UI 标红。数据中心 IP 上指纹做得再好也会被降级。'
  },
  {
    key: 'automation.cdp',
    label: 'CDP 存在痕迹（Runtime.enable / 调试端口）',
    layer: 'js',
    base: 'partial',
    serverVerifiable: true,
    usedBy: ['google'],
    detail: '注入层已处理 console.debug getter、Error.prepareStackTrace、webdriver 等已知探针，但 CDP 本身在内核里留了可观测的行为差。',
    action: '内核层补丁：去掉 CDP 在 JS 侧的可观测副作用；或指纹注入不走 CDP'
  },
  {
    key: 'native.toString',
    label: '被改写函数的 native 伪装',
    layer: 'js',
    base: 'partial',
    serverVerifiable: false,
    usedBy: ['google'],
    detail: '全局改写 Function.prototype.toString 本身就是一个可被验证的改写点（平台对象、getter 描述符、错误栈）。',
    action: '内核层：直接在 Blink 里返回真实属性，而不是 JS 层包装'
  },
  {
    key: 'render.pipeline',
    label: '渲染管线一致性（BotGuard 截图/光栅化）',
    layer: 'kernel',
    base: 'kernel-only',
    serverVerifiable: true,
    usedBy: ['google'],
    detail: 'BotGuard 会渲染一段内容并比对像素与 GPU 行为。JS 改 canvas 输出改不了内核真实渲染结果。',
    action: '只有自编译内核（在 Skia/Ganesh 层注入确定性扰动）才能与 JS 层噪声一致'
  },
  {
    key: 'webgl.readPixels',
    label: 'WebGL 真实渲染结果',
    layer: 'kernel',
    base: 'partial',
    serverVerifiable: true,
    usedBy: ['google'],
    detail: '已覆盖参数表、扩展列表与 readPixels 采样，但着色器精度与驱动差异仍来自真实 GPU。',
    action: '内核层统一 GPU 后端（SwiftShader 参数化）'
  },
  {
    key: 'media.codecs',
    label: '媒体编解码与 Widevine（H.264 / AAC / EME）',
    layer: 'kernel',
    base: 'covered',
    serverVerifiable: true,
    usedBy: ['google'],
    detail: 'canPlayType / MediaCapabilities 的返回值由内核构建决定：未品牌化构建缺 H.264 与 Widevine，一眼就能看出不是真实用户环境。',
    action: '改用正式版 Chrome（设置 → 内核 → 优先使用正式版）'
  },
  {
    key: 'events.trusted',
    label: '事件可信度与人类化时序',
    layer: 'js',
    base: 'covered',
    serverVerifiable: true,
    usedBy: ['google', 'x'],
    detail: 'RPA 走 CDP Input 域派发，事件 isTrusted 为 true；已加贝塞尔鼠标轨迹、打字节奏与随机停顿。'
  },
  {
    key: 'headless.shape',
    label: 'headless 形态差异（GPU / rAF / SW）',
    layer: 'kernel',
    base: 'covered',
    serverVerifiable: true,
    usedBy: ['google', 'x'],
    detail: '已默认 headed 启动，登录与真实站点操作不再走 headless。'
  },
  {
    key: 'webrtc.leak',
    label: 'WebRTC ICE / mDNS 泄漏',
    layer: 'js',
    base: 'partial',
    serverVerifiable: false,
    usedBy: ['google', 'x'],
    detail: '已按 mode 过滤 candidate 并对齐代理出口；但内核的 ICE 栈与 mDNS 行为在 STUN 对端仍可交叉验证。',
    action: '内核层禁用/接管 ICE 栈'
  },
  {
    key: 'fonts.metrics',
    label: '字体真实度量（文本 shaping）',
    layer: 'kernel',
    base: 'partial',
    serverVerifiable: false,
    usedBy: ['google'],
    detail: '已覆盖 fonts.check 与 measureText，但内核的字体回退与 shaping 结果取决于系统字体表。',
    action: '内核层：按 profile 注入字体清单与度量'
  },
  {
    key: 'clock.integrity',
    label: '时钟完整性（Date / performance.now）',
    layer: 'js',
    base: 'covered',
    serverVerifiable: true,
    usedBy: ['x'],
    detail: '刻意不改 Date：X 的 x-client-transaction-id 依赖与服务端的分钟级对齐，改时钟会直接废掉 API。'
  },
  {
    key: 'account.reputation',
    label: '账号信誉与登录态年龄',
    layer: 'js',
    base: 'partial',
    serverVerifiable: true,
    usedBy: ['google', 'x'],
    detail: '已有登录态保留策略、关键键保护、passkey 虚拟认证器与关联隔离；但账号本身的历史与权重无法由工具伪造。',
    action: '一环境一账号一住宅 IP，并保留登录态不重置'
  }
]

/**
 * 内核身份会改变若干向量的真实状态：
 * 未品牌化构建缺 H.264/Widevine（媒体能力立刻从 covered 降级），
 * 补丁内核则把渲染管线 / native 伪装 / CDP 痕迹从 partial 升级为 covered。
 */
function resolveStatus(key: string, identity: KernelIdentity, base: KernelGapItem['status']): KernelGapItem['status'] {
  const patched = identity.patchLevel > 0
  switch (key) {
    case 'media.codecs':
      // 未品牌化构建缺专有编解码与 Widevine，服务端一问就知道不是真实用户环境
      if (!identity.branded && !patched) return 'partial'
      return base
    case 'render.pipeline':
    case 'fonts.metrics':
      return patched ? 'covered' : base
    case 'native.toString':
    case 'automation.cdp':
      return patched ? 'covered' : base
    case 'tls.clientHello':
    case 'http2.settings':
      // 只有内核层替换 Hello/H2 实现才谈得上 covered；观测与比对仍是 partial
      return patched ? 'covered' : 'partial'
    case 'ua.coherence':
      // UA/CH 由 auto 对齐，TLS 由内核版本决定：三者同源才算 covered
      return identity.version === 'unknown' ? 'partial' : 'covered'
    default:
      return base
  }
}

export function buildGapReport(identity: KernelIdentity): KernelGapReport {
  const items: KernelGapItem[] = VECTORS.map((v) => ({
    key: v.key,
    label: v.label,
    layer: v.layer,
    status: resolveStatus(v.key, identity, v.base),
    serverVerifiable: v.serverVerifiable,
    usedBy: v.usedBy,
    detail: v.detail,
    ...(v.action ? { action: v.action } : {})
  }))

  const covered = items.filter((i) => i.status === 'covered').length
  const partial = items.filter((i) => i.status === 'partial').length
  const kernelOnly = items.filter((i) => i.status === 'kernel-only').length
  const coverage = Math.round((covered / items.length) * 100)

  const verdict: KernelGapReport['verdict'] =
    identity.patchLevel > 0 ? 'kernel-hardened' : partial + kernelOnly === 0 ? 'js-only' : 'partially-hardened'

  let advice: string
  if (identity.patchLevel > 0) {
    advice = `已使用补丁内核（level=${identity.patchLevel}），内核级向量已可控。保持补丁与 UA / TLS 基线同步更新。`
  } else if (!identity.branded) {
    advice =
      '当前内核不是品牌化正式版：缺 H.264/AAC/Widevine，媒体能力与更新通道都会露馅。建议在设置里把内核指向本机正式版 Chrome。'
  } else if (kernelOnly > 0) {
    advice =
      `内核层仍有 ${kernelOnly} 项只能靠自编译内核解决（渲染管线、字体 shaping 等）。JS 与网络层已尽力覆盖；要稳定扛 BotGuard 需要补丁内核。`
  } else {
    advice = '内核与网络层覆盖良好。剩余风险集中在账号信誉与批量关联，属于运营问题而非技术问题。'
  }

  return { identity, items, covered, partial, kernelOnly, coverage, verdict, advice }
}

/** 只挑出「服务端可复核且我们没覆盖」的项：这些才是真正会被打穿的口子 */
export function exploitableGaps(report: KernelGapReport): KernelGapItem[] {
  return report.items.filter((i) => i.serverVerifiable && i.status !== 'covered')
}