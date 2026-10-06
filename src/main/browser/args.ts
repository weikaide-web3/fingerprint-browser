import type { Profile } from '@shared/types'
import { languageListArg } from '@shared/lang'

/** 用户不可覆盖的内核参数前缀（由应用托管） */
const RESERVED = [
  '--user-data-dir',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--no-sandbox',
  '--proxy-server',
  '--proxy-bypass-list',
  '--headless',
  // 这两条由设置项托管，环境级参数不能把它们关掉
  '--simulate-outdated-no-au',
  '--test-type',
  // 窗口标题由环境名托管
  '--window-title',
  // 这三条由指纹层托管：环境级参数若覆盖它们，HTTP 头就会和 profile 配置不一致
  '--user-agent',
  '--lang',
  '--accept-lang',
  // 扩展加载由应用托管
  '--load-extension',
  '--disable-extensions-except'
]

/**
 * 压掉「构建过旧 / 建议更新到正式版 Chrome」黄条。
 * Playwright 缓存里的内核是未品牌化的测试构建（Google Chrome for Testing），
 * 它的自动更新截止判定会让内核自己弹这条提示。把判定日期推到 2099 年即可闭嘴。
 */
export const SUPPRESS_BUILD_INFOBAR = '--simulate-outdated-no-au=Tue, 31 Dec 2099 23:59:59 GMT'

/**
 * 压掉「您使用的是不受支持的命令行标记」黄条（--remote-debugging-port 会触发）。
 * 但 --test-type 本身是已知的自动化特征（还会关掉部分安全弹窗），所以默认不开。
 */
export const SUPPRESS_FLAG_INFOBAR = '--test-type'

export function sanitizeUserArgs(args: string[]): string[] {
  return args.filter((a) => !RESERVED.some((r) => a === r || a.startsWith(`${r}=`)))
}

export interface BuildArgsInput {
  profile: Profile
  userDataDir: string
  debugPort: number
  headless: boolean
  extraArgs?: string[]
  /** 覆盖代理入口，形如 http://127.0.0.1:3128（带凭据的代理走本地 relay 时用） */
  proxyServerUrl?: string
  /** 设置页里的「启动参数模板」，对所有环境生效 */
  templateArgs?: string[]
  /** 隐藏「测试版 / 建议更新」黄条（默认开） */
  suppressBuildInfobar?: boolean
  /** 隐藏「不受支持的命令行标记」黄条（默认关：--test-type 是自动化特征） */
  suppressFlagInfobar?: boolean
}

/** IPv6 地址在 URL 形式里必须加方括号 */
function proxyHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/**
 * 把设置里的「启动参数模板」切成参数数组。
 * 行为贴近 shell：引号内的空格不算分隔符，所以 --window-title="a b" 会变成一个参数。
 */
export function parseArgsTemplate(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let started = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      let inner = ''
      while (j < text.length && text[j] !== quote) {
        inner += text[j]
        j += 1
      }
      cur += inner
      started = true
      i = j
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  return out
}

export function buildLaunchArgs(input: BuildArgsInput): string[] {
  const { profile, userDataDir, debugPort, headless } = input
  const fp = profile.fingerprint
  const args: string[] = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--window-title=${profile.name}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    // 刻意不加 --disable-component-update：本机实测它会让正式版 Chrome 的
    // Widevine CDM 注册不上（requestMediaKeySystemAccess 直接 NotSupportedError），
    // 而真实用户的 Chrome 一定有 Widevine —— 缺它反而是 VM / 自动化的硬特征。
    // 需要完全离线时在启动参数里手动加回来即可（环境级参数可覆盖）。
    '--disable-default-apps',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider',
    '--metrics-recording-only',
    '--no-service-autorun',
    '--password-store=basic'
  ]

  // 黄条会把真实布局视口压掉 40-60px：注入层按配置写出来的 innerHeight 与内核真实的
  // documentElement.clientHeight 就对不上，检测站一比即暴露注入痕迹；截图里也会拍到黄条。
  // 所以默认压掉「测试版 / 建议更新」提示，--test-type 因为自带自动化特征而默认不开。
  if (input.suppressBuildInfobar !== false) args.push(SUPPRESS_BUILD_INFOBAR)
  if (input.suppressFlagInfobar === true) args.push(SUPPRESS_FLAG_INFOBAR)

  if (headless) args.push('--headless=new')

  if (fp) {
    // UA 必须在启动参数里给，不能只靠 CDP 覆盖：
    // ① CDP 的 setUserAgentOverride 是逐页异步下发的，新页面的第一次导航会抢在覆盖之前发出，
    //    于是首个请求带的是内核真实 UA（headless 下就是 HeadlessChrome）—— 服务端只看第一个请求就够了；
    // ② 启动参数对所有 frame、所有请求、以及 Service Worker 都一致生效。
    // CDP 覆盖仍然保留，它负责 platform 与 Client Hints 元数据。
    args.push(`--user-agent=${fp.ua.ua}`)
    args.push(`--lang=${fp.language.intlLocale}`)
    // 只传裸 tag：内核会自己按规则生成 q 值。传带 q 的完整头会被再算一遍，
    // 得到 "…;q=0.9;q=0.8" 这种真实 Chrome 绝不会发的形状。
    args.push(`--accept-lang=${languageListArg(fp.language.languages)}`)
    args.push(`--window-size=${fp.screen.windowWidth},${fp.screen.windowHeight}`)
    if (fp.webgl.blockWebgl) args.push('--disable-webgl')
    // WebRTC 必须始终禁止「不走代理的 UDP」：否则页面用 RTCPeerConnection
    // 就能直接 UDP 打出去，拿到真实公网 IP 与内网地址，完全绕过 --proxy-server。
    // JS 层改写候选只解决「读得到什么」，这一层解决「实际发到哪」。
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
    if (fp.webrtc.mode === 'disable') args.push('--disable-features=WebRTCPipeWireCapturer')
    if (fp.launch.ignoreCertificateErrors) args.push('--ignore-certificate-errors')
    // disableFeatures 每项都被固定前缀包住，无法越权改写别的开关，保持原样。
    for (const f of fp.launch.disableFeatures) args.push(`--disable-blink-features=${f}`)
    // launch.args 是用户可自由填写的整条参数，必须过保留参数过滤：
    // 否则其中的 --user-agent / --proxy-server / --no-sandbox 会覆盖指纹层与
    // 代理层写好的值，正是 RESERVED 注释里要防的「HTTP 头与 profile 配置不一致」。
    for (const a of sanitizeUserArgs(fp.launch.args)) args.push(a)
  }

  if (input.proxyServerUrl) {
    args.push(`--proxy-server=${input.proxyServerUrl}`)
    args.push('--proxy-bypass-list=<-loopback>')
  } else if (profile.proxy && profile.proxyMode === 'bind') {
    const p = profile.proxy
    // Chrome 只认 socks5://，socks5h 的远端 DNS 语义由 launcher 通过 --host-resolver-rules 实现
    const chromeScheme = p.scheme === 'socks5h' ? 'socks5' : p.scheme
    args.push(`--proxy-server=${chromeScheme}://${proxyHost(p.host)}:${p.port}`)
    args.push('--proxy-bypass-list=<-loopback>')
  }

  // 注意：这里**不设** --download-path。Chromium 根本没有这个命令行开关
  // （content_switches.cc / chrome_switches.cc 里都不存在），传了会被静默忽略，
  // 下载会落到系统 ~/Downloads，导致所有环境的下载混在一起、跨环境泄漏。
  // 真正的下载目录由 launcher 用 CDP Browser.setDownloadBehavior 设置，见 setDownloadDir。
  // 模板在前、环境自身参数在后：同名开关以离环境更近的那个为准
  args.push(...sanitizeUserArgs(input.templateArgs ?? []))
  args.push(...sanitizeUserArgs(profile.launchArgs))
  args.push(...(input.extraArgs ?? []))
  return args
}
