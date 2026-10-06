import { getSetting, setSetting } from '../db/repositories/settings'
import type { SettingGroup, SettingOption, SettingType, SettingView } from '@shared/settings'

export type { SettingGroup, SettingOption, SettingType, SettingView }

/**
 * 设置项集中定义。
 *
 * 集中定义的意义：界面按定义渲染（不用手写一堆控件）、写入前统一校验、
 * 主进程各处读取时都有默认值 —— 避免出现「某处 getSetting 把 key 拼错，
 * 于是静默用了 undefined」这类难查的问题。
 */

export interface SettingDef {
  key: string
  label: string
  description: string
  group: SettingGroup
  type: SettingType
  /** 默认值：库里没有该 key 时返回它 */
  def: string | number | boolean | null
  options?: SettingOption[]
  /** 返回错误信息表示非法值；返回 null 表示通过 */
  validate?: (v: unknown) => string | null
  /** 修改后需要重启应用 / 重启环境才生效 */
  restart?: 'app' | 'profile'
  /** 只读项（由系统计算，界面不给输入框） */
  readonly?: boolean
}

const isPort = (v: unknown): string | null => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return '端口必须是 0-65535 的整数（0 表示自动分配）'
  return null
}

const isPositiveInt = (min = 1) => (v: unknown): string | null => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) return `必须是 >= ${min} 的整数`
  return null
}

export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'chromiumExecutable',
    label: '自定义内核路径',
    description: '留空则使用 Playwright 缓存里的 Chromium；填写后优先用它（可指向 Chrome / Chrome for Testing）。',
    group: '内核',
    type: 'string',
    def: '',
    validate: (v) => (typeof v === 'string' && v && !v.startsWith('/') ? '必须是绝对路径' : null),
    restart: 'profile'
  },
  {
    key: 'preferBrandedChrome',
    label: '优先使用正式版 Google Chrome',
    description:
      '未指定内核路径时，优先用本机正式版 Chrome 而不是 Playwright 自带的 Chrome for Testing。正式版不会弹「测试版本 / 建议更新」提示，且带真实用户才有的媒体编解码与 Widevine，指纹更接近真人。',
    group: '内核',
    type: 'boolean',
    def: true,
    restart: 'profile'
  },
  {
    key: 'suppressBuildInfobar',
    label: '隐藏「测试版 / 建议更新」黄条',
    description:
      '加 --simulate-outdated-no-au 压掉内核的构建过旧提示。黄条会把真实视口压掉几十像素，让注入层写的窗口尺寸与内核真实布局对不上；用未品牌化内核时建议保持开启。',
    group: '内核',
    type: 'boolean',
    def: true,
    restart: 'profile'
  },
  {
    key: 'suppressFlagInfobar',
    label: '隐藏「不受支持的命令行标记」黄条',
    description:
      '加 --test-type 可去掉该提示，但它本身是已知的自动化特征（会关掉部分安全弹窗）。除非确实被这条黄条困扰，否则建议保持关闭。',
    group: '内核',
    type: 'boolean',
    def: false,
    restart: 'profile'
  },
  {
    key: 'kernelVersionCache',
    label: '内核版本号覆盖',
    description: 'auto 模式用它对齐 UA 与 Client Hints。留空则自动读取内核 Info.plist。',
    group: '内核',
    type: 'string',
    def: '',
    validate: (v) => (typeof v === 'string' && v && !/^\d+(\.\d+)*$/.test(v) ? '版本号格式应为 132.0.6834.110' : null),
    restart: 'profile'
  },
  {
    key: 'launchArgsTemplate',
    label: '启动参数模板',
    description: '对所有环境追加的内核参数，空格分隔。保留参数（user-data-dir / proxy-server 等）会被自动过滤。',
    group: '启动参数',
    type: 'string',
    def: '',
    restart: 'profile'
  },
  {
    key: 'defaultHeadless',
    label: '默认以 headless 启动',
    description: '界面「打开」时也以后台模式启动内核（自动化 / 批量场景用）。',
    group: '启动参数',
    type: 'boolean',
    def: false,
    restart: 'profile'
  },
  {
    key: 'maxConcurrentProfiles',
    label: '同时运行环境上限',
    description: '防止一次开太多环境把机器压垮；0 表示不限制。',
    group: '启动参数',
    type: 'number',
    def: 8,
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0) return '必须是 >= 0 的整数'
      return null
    }
  },
  {
    key: 'relayPort',
    label: '代理 relay 起始端口',
    description: '带账号密码的代理会经本机 relay 转换；0 表示随机端口。',
    group: '代理',
    type: 'number',
    def: 0,
    validate: isPort,
    restart: 'profile'
  },
  {
    key: 'proxy.checkTimeoutMs',
    label: '代理检测超时（毫秒）',
    description: '单个代理的建连 + 出口查询超时。',
    group: '代理',
    type: 'number',
    def: 10000,
    validate: isPositiveInt(1000)
  },
  {
    key: 'proxy.checkUrl',
    label: '出口信息查询地址',
    description:
      '必须是 http/https 的绝对地址，返回 ip-api 风格 JSON。自建服务或离线环境可指向自己的探测点。' +
      '默认探测点 ip-api.com 免费版只支持 http 且不返回 usageType / anycast / reverse，' +
      '此时出口质量判定会降级（结果里会列出缺少的信号）。要完整判定请改用 https 的自建或付费探测点。',
    group: '代理',
    type: 'string',
    def: '',
    validate: (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? '只支持 http:// 或 https:// 绝对地址' : null)
  },
  {
    key: 'proxy.checkConcurrency',
    label: '代理批量检测并发数',
    description: '一次检测多少个代理。太大容易被代理服务商限流。',
    group: '代理',
    type: 'number',
    def: 4,
    validate: isPositiveInt(1)
  },
  {
    key: 'apiEnabled',
    label: '启用本机自动化 API',
    description: '开启后提供 AdsPower 兼容的 HTTP 接口，Selenium / Puppeteer 可直接驱动环境。',
    group: '自动化 API',
    type: 'boolean',
    def: true,
    restart: 'app'
  },
  {
    key: 'apiPort',
    label: 'API 端口',
    description: '只监听 127.0.0.1。0 表示随机端口。',
    group: '自动化 API',
    type: 'number',
    def: 52222,
    validate: isPort,
    restart: 'app'
  },
  {
    key: 'apiToken',
    label: 'API Token',
    description: '调用 /api/v1/* 需在 Authorization: Bearer 或 ?token= 里带上。留空表示不鉴权（仅本机可达）。',
    group: '自动化 API',
    type: 'secret',
    def: '',
    restart: 'app'
  },
  {
    key: 'rpaHumanizePreset',
    label: 'RPA 行为人类化预设',
    description:
      '鼠标轨迹、点击落点、打字节奏与动作间隔的拟人程度。访问 Google / X 等有行为风控的站点必须开启：瞬移鼠标 + 一次性填表是教科书级机器人特征。',
    group: '自动化',
    type: 'select',
    def: 'standard',
    options: [
      { value: 'off', label: '关闭（最快，但极易被判定为机器人）' },
      { value: 'light', label: '轻度（仅鼠标与间隔，适合本地测试）' },
      { value: 'standard', label: '标准（推荐：鼠标 + 逐字输入 + 随机间隔）' },
      { value: 'aggressive', label: '强（含打字纠错，最慢但最像真人）' }
    ],
    restart: 'profile'
  },
  {
    key: 'defaultSessionPolicy',
    label: '新建环境的登录态策略',
    description: '关闭环境时如何处理 cookie：保留 / 清 cookie / 清空整个隔离目录。',
    group: '会话与检测',
    type: 'select',
    def: 'keep',
    options: [
      { value: 'keep', label: '保留登录态' },
      { value: 'clear_cookies', label: '关闭时清 cookie' },
      { value: 'clear_all', label: '关闭时清空隔离目录' }
    ]
  },
  {
    key: 'detectSamples',
    label: '指纹检测采样次数',
    description: '>=2 才能验证 Canvas / Audio 噪声是否稳定。',
    group: '会话与检测',
    type: 'number',
    def: 2,
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 3) return '只能是 1-3 的整数'
      return null
    }
  },
  {
    key: 'transientHeadless',
    label: '临时拉起内核时用 headless',
    description:
      '读写登录态 / 指纹检测时若环境未运行，会临时拉起同一个环境。headless 的渲染管线、rAF 时序、serviceWorker 行为都与有头不同，在 Google / X 眼里是另一类设备 —— 除非明确知道自己在做什么，否则保持关闭。登录、发帖、RPA 等访问真实站点的操作会无视此项，强制有头。',
    group: '会话与检测',
    type: 'boolean',
    def: false,
    restart: 'profile'
  },
  {
    key: 'closeAllOnQuit',
    label: '退出应用时关闭所有环境',
    description: '关闭前会按各环境的登录态策略清理。',
    group: '其它',
    type: 'boolean',
    def: true
  },
  {
    key: 'assoc.maxAccountsPerProxy',
    label: '单个代理可绑定的环境数',
    description: '商用实践是 1 个环境 1 个出口。共用出口会让多个账号在服务端看来是同一个人操作，一个被封其余连坐。',
    group: '关联隔离',
    type: 'number',
    def: 1,
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 50) return '只能是 1-50 的整数'
      return null
    }
  },
  {
    key: 'assoc.maxAccountsPerIp',
    label: '同一出口 IP 的账号数上限',
    description: '超过这个数量就判定为批量操作特征。住宅 IP 可以稍宽，机房 IP 应当是 1。',
    group: '关联隔离',
    type: 'number',
    def: 3,
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 100) return '只能是 1-100 的整数'
      return null
    }
  },
  {
    key: 'assoc.dormantDays',
    label: '账号休眠告警天数',
    description: '超过该天数未使用的账号，重新登录时更容易被要求验证；这里只做提示，不自动处理。',
    group: '关联隔离',
    type: 'number',
    def: 90,
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 3650) return '只能是 1-3650 的整数'
      return null
    }
  },
  {
    key: 'tls.probeUrl',
    label: 'TLS 观测目标地址',
    description:
      '留空则用本机 HTTP/2 源服务器（唯一能同时看到 ClientHello 与 H2 SETTINGS 帧的目标，推荐）。' +
      '填写则改用它观测 ClientHello —— 此时看不到 H2 帧，h2fp 会为空。',
    group: 'TLS / HTTP2',
    type: 'string',
    def: '',
    validate: (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? '必须是 http(s):// 绝对地址' : null)
  },
  {
    key: 'tls.echoUrl',
    label: 'TLS 指纹回显服务',
    description: '返回 ja3 / ja4 / akamai(h2) 的 JSON 接口（自建或第三方）。留空则只做事后被动观测，不比对服务端所见。',
    group: 'TLS / HTTP2',
    type: 'string',
    def: '',
    validate: (v) => (typeof v === 'string' && v && !/^https?:\/\//i.test(v) ? '必须是 http(s):// 绝对地址' : null)
  },
  {
    key: 'tls.autoBaseline',
    label: '自动采集内核 TLS 基线',
    description: '观测到新的内核版本时，自动把它的 TLS 形状记为基线；之后任何环境偏离基线都会被标红。',
    group: 'TLS / HTTP2',
    type: 'boolean',
    def: true
  },
  {
    key: 'assoc.blockOnRun',
    label: 'RPA 运行前阻断高危关联',
    description: '开启后，流程运行前会检查关联风险；存在 error 级问题时拒绝启动（可在单次运行时临时跳过）。',
    group: '关联隔离',
    type: 'boolean',
    def: true
  },
  {
    key: 'monitor.proxyAutoCheck',
    label: '代理自动检测',
    description: '后台定时检测所有代理的连通性与出口质量，失效的代理会在代理页标红。关闭则只在手动检测时更新。',
    group: '后台监控',
    type: 'boolean',
    def: true
  },
  {
    key: 'monitor.proxyIntervalMin',
    label: '代理自动检测间隔（分钟）',
    description: '代理自动检测的运行频率，默认 30 分钟一次。',
    group: '后台监控',
    type: 'number',
    def: 30,
    validate: isPositiveInt(1)
  },
  {
    key: 'monitor.cookieExpiry',
    label: '登录态到期提醒',
    description: '后台检查各环境的登录态保留策略，对即将到期 / 已过期的环境给出提醒。',
    group: '后台监控',
    type: 'boolean',
    def: true
  },
  {
    key: 'monitor.drift',
    label: '指纹漂移自动检测',
    description: '后台定期对已检测过的环境重新采样指纹，与上次分数比对；明显下降时告警。会拉起内核，开销较大，默认关闭。',
    group: '后台监控',
    type: 'boolean',
    def: false
  },
  {
    key: 'monitor.driftIntervalMin',
    label: '指纹漂移检测间隔（分钟）',
    description: '指纹漂移检测的运行频率，默认 720 分钟（12 小时）一次。',
    group: '后台监控',
    type: 'number',
    def: 720,
    validate: isPositiveInt(5)
  }
]

const DEF_MAP = new Map(SETTING_DEFS.map((d) => [d.key, d]))

export function findDef(key: string): SettingDef | undefined {
  return DEF_MAP.get(key)
}

/** 读取带默认值的设置；未定义的 key 返回调用方给的兜底 */
export function typedSetting<T extends string | number | boolean | null>(key: string, fallback?: T): T {
  const def = DEF_MAP.get(key)
  const base = (fallback ?? (def?.def ?? null)) as T
  return getSetting<T>(key, base)
}

/** 归一化 + 校验（纯函数，便于单测）；非法值抛错 */
export function normalizeAndValidate(key: string, value: unknown): { def: SettingDef; value: string | number | boolean } {
  const def = DEF_MAP.get(key)
  if (!def) throw new Error(`未知设置项：${key}`)
  if (def.readonly) throw new Error(`${def.label} 是只读项`)
  let normalized: string | number | boolean
  if (def.type === 'number') {
    if (value === '' || value === null || Number.isNaN(Number(value))) throw new Error(`${def.label} 必须是数字`)
    normalized = Number(value)
  } else if (def.type === 'boolean') {
    normalized = value === true || value === 'true' || value === 1 || value === '1'
  } else if (def.type === 'select') {
    const allowed = (def.options ?? []).map((o) => o.value)
    if (!allowed.includes(String(value))) throw new Error(`${def.label} 只能是 ${allowed.join(' / ')}`)
    normalized = String(value)
  } else {
    normalized = value === null ? '' : String(value)
  }
  const err = def.validate?.(normalized)
  if (err) throw new Error(`${def.label}：${err}`)
  return { def, value: normalized }
}

/** 写入前校验；非法值直接抛错，避免把脏配置带进内核启动参数 */
export function setTypedSetting(key: string, value: unknown): SettingDef {
  const { def, value: normalized } = normalizeAndValidate(key, value)
  setSetting(key, normalized)
  return def
}

export function resetSetting(key: string): SettingDef {
  const def = findDef(key)
  if (!def) throw new Error(`未知设置项：${key}`)
  setSetting(key, def.def)
  return def
}

/**
 * 给设置页用：定义 + 当前值 + 是否为默认值。
 *
 * secret 类型的真实值**不回传渲染进程**：value 恒为空串，只给出 secretSet。
 * 渲染进程是应用里最容易被站点脚本波及的一侧（登录页本身就是攻击面），
 * 而设置页会被轮询 —— 原样回传等于每次轮询都泄漏一次 Token。
 */
export function settingsView(): SettingView[] {
  return SETTING_DEFS.map((def) => {
    const { validate, ...rest } = def
    void validate
    const raw = getSetting(def.key, def.def)
    if (def.type === 'secret') {
      const set = raw !== null && raw !== undefined && String(raw) !== ''
      return { ...rest, value: '', isDefault: !set, secretSet: set }
    }
    return { ...rest, value: raw, isDefault: String(raw) === String(def.def) }
  })
}