import type { DetectItem, DetectStatus } from '@shared/detect'
import type { Http2Fingerprint, TlsBaseline, TlsFingerprintView } from '@shared/tls'

/**
 * TLS / HTTP2 观测值与「本机内核基线」的比对（纯函数）。
 *
 * 我们没有能力从 JS 层改 ClientHello，所以这里做的不是「伪造成 Chrome」，
 * 而是三件更有用的事：
 *   1. 把真实 JA3/JA4/H2 形状显示给用户，与检测站看到的对得上；
 *   2. 与同版本内核的基线比对 —— 不一致说明这个环境用了别的内核 / 别的出口链路；
 *   3. 检查 UA 声明的主版本与内核实测主版本是否一致（TLS 形状出卖的就是内核版本）。
 */

const G = 'TLS / HTTP2'

function item(
  key: string,
  label: string,
  expected: string,
  actual: string,
  status: DetectStatus,
  note?: string
): DetectItem {
  return { group: G, key, label, expected, actual, status, ...(note ? { note } : {}) }
}

export interface TlsCompareInput {
  tls: TlsFingerprintView
  h2: Http2Fingerprint | null
  baseline: TlsBaseline | null
  /** profile 的 UA 里声明的 Chrome 主版本 */
  declaredMajor: number | null
  /** 实际启动的内核版本（来自 Info.plist / 设置覆盖） */
  kernelVersion: string
  /** 观测到的目标主机，用于确认 SNI 没被吃掉 */
  host: string
  /** 回显服务看到的指纹（可选） */
  echo?: { ja4: string | null; h2fp: string | null; httpVersion: string | null } | null
  /** 目标是 IP / 单标签名时 SNI 不适用 */
  sniNotApplicable?: boolean
}

/**
 * 取 Chrome 主版本。
 *
 * 入参可能是两种形态：内核版本号（"154.0.7610.0"）或整条 UA。
 * 直接取第一个 "数字." 在 UA 上会命中 "Mozilla/5.0" 而返回 5 ——
 * 那会让「UA 版本 vs 内核版本」这项永远误报，所以必须先找浏览器品牌标记。
 */
export function chromeMajor(version: string): number | null {
  const s = String(version ?? '')
  const branded = /(?:Chrome|CriOS|Edg|Edge|Chromium)\/(\d+)(?:\.\d+)?/.exec(s)
  if (branded) return Number(branded[1])
  const m = /(\d+)\./.exec(s)
  return m ? Number(m[1]) : null
}

export function compareTls(input: TlsCompareInput): DetectItem[] {
  const { tls, h2, baseline, declaredMajor, kernelVersion, host } = input
  const out: DetectItem[] = []

  out.push(
    item(
      'tls.version',
      'TLS 版本',
      '13',
      tls.versionLabel,
      tls.versionLabel === '13' ? 'ok' : 'mismatch',
      '现代 Chrome 一律 TLS 1.3；停在 12 说明链路被降级或内核过旧'
    )
  )

  const alpn = tls.alpn.join(',')
  out.push(
    item(
      'tls.alpn',
      'ALPN 协商',
      'h2',
      alpn || '—',
      tls.alpn.includes('h2') ? 'ok' : 'mismatch',
      'Chrome 一定会协商 h2；只有 http/1.1 说明中间有代理把 ALPN 剥掉了'
    )
  )

  out.push(
    item(
      'check.tlsGrease',
      'ClientHello 含 GREASE',
      '> 0',
      String(tls.greaseCount),
      tls.greaseCount > 0 ? 'ok' : 'mismatch',
      '真实 Chrome 会随机插入 GREASE 占位值；自己拼 ClientHello 的工具通常忘记带，这本身就是机器人特征'
    )
  )

  const sniNa = input.sniNotApplicable === true
  out.push(
    item(
      'check.tlsSni',
      'SNI 与目标一致',
      sniNa ? '不适用' : host,
      tls.sni ?? '—',
      sniNa ? 'unknown' : tls.sni === host ? 'ok' : 'mismatch',
      sniNa
        ? '目标是 IP 或单标签主机名，按 RFC 6066 本就不该发送 SNI'
        : 'SNI 缺失或与目标不同，说明中间做了 TLS 终结（MITM）'
    )
  )

  const kernelMajor = chromeMajor(kernelVersion)
  if (declaredMajor !== null && kernelMajor !== null) {
    out.push(
      item(
        'check.tlsKernelCoherence',
        'UA 声明版本 = 内核实测版本',
        String(declaredMajor),
        String(kernelMajor),
        declaredMajor === kernelMajor ? 'ok' : 'mismatch',
        'TLS 形状由内核版本决定：UA 写 120 而内核是 153，服务端一眼看出矛盾'
      )
    )
  } else {
    out.push(item('check.tlsKernelCoherence', 'UA 声明版本 = 内核实测版本', '—', '—', 'unknown', '缺少 UA 或内核版本，无法比对'))
  }

  for (const [key, label, exp, act, note] of [
    ['tls.ja4', 'JA4 指纹', baseline?.ja4 ?? null, tls.ja4, '与同版本内核的基线不同 → 这个环境换了内核或换了出口链路'],
    [
      'tls.ja3',
      'JA3 指纹（去 GREASE + 排序）',
      baseline?.ja3Sorted ?? baseline?.ja3Stable ?? null,
      tls.ja3Sorted || tls.ja3Stable,
      'Chrome 每次连接都随机插入 GREASE 并打乱扩展顺序，原始 JA3 必然每次不同；基线比对用的是去 GREASE 且排序后的 JA3'
    ],
    ['tls.ciphers', '密码套件数量', baseline ? String(baseline.cipherCount) : null, String(tls.cipherCount), '与同版本内核的基线不同 → 这个环境换了内核或换了出口链路'],
    ['tls.extensions', '扩展数量', baseline ? String(baseline.extensionCount) : null, String(tls.extensionCount), '与同版本内核的基线不同 → 这个环境换了内核或换了出口链路']
  ] as const) {
    out.push(
      item(
        key,
        label,
        exp ?? '—',
        act,
        exp === null ? 'unknown' : exp === act ? 'ok' : 'mismatch',
        exp === null ? '还没有本机内核基线：先跑一次「采集基线」' : note
      )
    )
  }

  // 原始 JA3 只用于与第三方回显对账：GREASE 随机导致它跨连接必然不同，不参与判定
  out.push(
    item(
      'tls.ja3Raw',
      'JA3 原始值（含 GREASE）',
      baseline?.ja3 ?? '—',
      tls.ja3,
      'unknown',
      'Chrome 每次连接随机插入 GREASE，原始 JA3 每次都不同 —— 这一项只用于与第三方回显对账，不参与基线判定'
    )
  )

  // 扩展的线上顺序本身也是信号：真 Chrome 会打乱它，所以「两次观测顺序恒定」
  // 反而可疑（说明客户端没有实现扩展顺序随机化）。这里只做展示，不判定。
  out.push(
    item(
      'tls.extOrder',
      '扩展线上顺序（去 GREASE）',
      '—',
      tls.extOrder || '—',
      'unknown',
      '真 Chrome 110+ 会随机打乱扩展顺序，因此这一项每次连接都不同；固定不变反而是自动化工具的特征'
    )
  )

  const h2fp = h2?.fp ?? null
  out.push(
    item(
      'h2.fp',
      'HTTP/2 SETTINGS 指纹',
      baseline?.h2fp ?? '—',
      h2fp ?? '未观测',
      h2fp === null ? 'unknown' : baseline?.h2fp ? (baseline.h2fp === h2fp ? 'ok' : 'mismatch') : 'unknown',
      'H2 帧在 TLS 之内，只有回显服务（echo 模式）或本地源服务器观测才拿得到；tap 模式看不到'
    )
  )

  // 被动观测 vs 服务端所见：两者不一致 = 中间有设备在做 TLS 终结
  if (input.echo) {
    const echoJa4 = input.echo.ja4
    out.push(
      item(
        'check.tlsNoTermination',
        '本机观测的 JA4 = 服务端看到的 JA4',
        echoJa4 ?? '—',
        tls.ja4,
        echoJa4 === null ? 'unknown' : echoJa4 === tls.ja4 ? 'ok' : 'mismatch',
        '不一致说明链路上有代理 / 企业网关 / 杀软重新发起了 TLS 握手，出口指纹已不是内核算的'
      )
    )
    if (input.echo.h2fp !== null) {
      out.push(
        item(
          'check.h2NoRewrite',
          '服务端看到的 H2 指纹与基线一致',
          baseline?.h2fp ?? '—',
          input.echo.h2fp,
          baseline?.h2fp ? (baseline.h2fp === input.echo.h2fp ? 'ok' : 'mismatch') : 'unknown',
          'H2 SETTINGS 被中间设备改写，等于换了一台客户端'
        )
      )
    }
    out.push(
      item(
        'check.httpNegotiated',
        '实际协商的 HTTP 版本',
        'h2',
        input.echo.httpVersion ?? '—',
        input.echo.httpVersion === null || input.echo.httpVersion === undefined
          ? 'unknown'
          : input.echo.httpVersion === 'h2'
            ? 'ok'
            : 'mismatch',
        '被降级到 http/1.1 通常意味着中间有代理，H2 指纹这一层直接失效'
      )
    )
  }

  return out
}