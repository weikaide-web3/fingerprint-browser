/**
 * 账号保管（站点账号 / 2FA / 自动填充）的共用契约。
 *
 * 为什么必须把账号与环境绑定：Google 与 X 都会把「账号 ↔ 设备 ↔ 出口 IP」
 * 当成一个三元组来评估。账号在 A 环境注册、却在 B 环境登录，
 * 即使两边指纹都完美，服务端看到的也是「同一账号在两台设备上同时出现」。
 */

export type AccountPlatform =
  | 'google'
  | 'twitter'
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'linkedin'
  | 'amazon'
  | 'github'
  | 'other'

export const ACCOUNT_PLATFORMS: AccountPlatform[] = [
  'google',
  'twitter',
  'facebook',
  'instagram',
  'tiktok',
  'linkedin',
  'amazon',
  'github',
  'other'
]

/** 库里出来的记录：刻意不含任何机密，机密只在主进程解密后瞬时使用 */
export interface AccountRecord {
  id: string
  profileId: string | null
  platform: AccountPlatform
  username: string
  email: string | null
  phone: string | null
  note: string | null
  hasPassword: boolean
  hasTotp: boolean
  /** 2FA 类型：无 / TOTP / 仅短信（短信无法自动，需要人工接收） */
  totpKind: 'none' | 'totp' | 'sms'
  /** 账号最初注册/录入时所在的环境；与 profileId 不同意味着换设备登录 */
  createdProfileId: string | null
  loginCount: number
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface AccountInput {
  profileId?: string | null
  platform: AccountPlatform
  username: string
  password?: string | null
  /** 支持裸 Base32 密钥或 otpauth:// URI */
  totpSecret?: string | null
  email?: string | null
  phone?: string | null
  note?: string | null
}

export interface TotpCodeView {
  accountId: string
  code: string
  digits: number
  periodSeconds: number
  remainingSeconds: number
  generatedAt: number
}

/** 自动填充计划里的一步：选择器 + 要填的值（null 表示只点击不填） */
export interface AutofillPlanField {
  purpose: string
  selector: string
  value: string | null
}

/**
 * 填充计划：主进程生成、渲染进程展示、执行器消费。
 * 刻意把「计划」与「执行」分开 —— 计划可以给人确认，机密只在执行瞬间进内存。
 */
export interface AutofillPlan {
  accountId: string
  username: string
  platform: AccountPlatform
  loginUrl: string | null
  successSelector: string | null
  steps: AutofillPlanField[]
  warnings: string[]
}

/** 同一账号被绑到多个环境：Google / X 会看到「同账号多设备」，必须告警 */
export interface AccountConflict {
  key: string
  username: string
  platform: string
  profileIds: string[]
}

/** 自动填充：把「该站点用户名框是哪个」这类站点知识集中管理 */
export interface AutofillField {
  /** username / password / totp / submit */
  purpose: 'username' | 'password' | 'totp' | 'submit'
  selectors: string[]
  /** 填入的值由调用方注入，不写死在预设里 */
  valueKey: 'username' | 'email' | 'password' | 'totp' | null
}

export interface AutofillPreset {
  platform: AccountPlatform
  label: string
  loginUrl: string | null
  /** 登录成功判据：出现该元素即认为已登录 */
  successSelector: string | null
  fields: AutofillField[]
}

export const AUTOFILL_PRESETS: Record<AccountPlatform, AutofillPreset> = {
  google: {
    platform: 'google',
    label: 'Google',
    loginUrl: 'https://accounts.google.com/signin/v2/identifier',
    successSelector: 'a[href*="myaccount.google.com"]',
    fields: [
      // Google 是分步表单：先用户名，提交后再出密码框
      { purpose: 'username', selectors: ['input#identifier', 'input[type="email"]'], valueKey: 'username' },
      { purpose: 'submit', selectors: ['button[type="submit"]', '#identifierNext'], valueKey: null },
      { purpose: 'password', selectors: ['input#password', 'input[type="password"]'], valueKey: 'password' },
      { purpose: 'totp', selectors: ['input[aria-label*="验证码"]', 'input[type="text"][inputmode="numeric"]'], valueKey: 'totp' }
    ]
  },
  twitter: {
    platform: 'twitter',
    label: 'X / Twitter',
    loginUrl: 'https://x.com/i/flow/login',
    successSelector: '[data-testid="AppTabBar_Home_Link"]',
    fields: [
      { purpose: 'username', selectors: ['input[autocomplete="username"]', 'input[name="text"]'], valueKey: 'username' },
      { purpose: 'submit', selectors: ['div[role="button"][tabindex="0"]'], valueKey: null },
      { purpose: 'password', selectors: ['input[autocomplete="current-password"]', 'input[name="password"]'], valueKey: 'password' },
      { purpose: 'totp', selectors: ['input[name="text"]'], valueKey: 'totp' }
    ]
  },
  facebook: {
    platform: 'facebook',
    label: 'Facebook',
    loginUrl: 'https://www.facebook.com/login',
    successSelector: null,
    fields: [
      { purpose: 'username', selectors: ['input#email', 'input[name="email"]'], valueKey: 'username' },
      { purpose: 'password', selectors: ['input#pass', 'input[name="pass"]'], valueKey: 'password' },
      { purpose: 'submit', selectors: ['button[name="login"]', 'input[type="submit"]'], valueKey: null },
      { purpose: 'totp', selectors: ['input[name="approvals_code"]'], valueKey: 'totp' }
    ]
  },
  instagram: {
    platform: 'instagram',
    label: 'Instagram',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    successSelector: null,
    fields: [
      { purpose: 'username', selectors: ['input#username', 'input[name="username"]'], valueKey: 'username' },
      { purpose: 'password', selectors: ['input#password', 'input[name="password"]'], valueKey: 'password' },
      { purpose: 'submit', selectors: ['button[type="submit"]'], valueKey: null },
      { purpose: 'totp', selectors: ['input#confirmation_code'], valueKey: 'totp' }
    ]
  },
  tiktok: {
    platform: 'tiktok',
    label: 'TikTok',
    loginUrl: 'https://www.tiktok.com/login',
    successSelector: null,
    fields: [
      { purpose: 'username', selectors: ['input[name="username"]'], valueKey: 'username' },
      { purpose: 'password', selectors: ['input[name="password"]', 'input[type="password"]'], valueKey: 'password' },
      { purpose: 'submit', selectors: ['button[type="submit"]'], valueKey: null },
      { purpose: 'totp', selectors: [], valueKey: 'totp' }
    ]
  },
  linkedin: {
    platform: 'linkedin',
    label: 'LinkedIn',
    loginUrl: 'https://www.linkedin.com/login',
    successSelector: 'a[href*="/feed"]',
    fields: [
      { purpose: 'username', selectors: ['input#username'], valueKey: 'username' },
      { purpose: 'password', selectors: ['input#password'], valueKey: 'password' },
      { purpose: 'submit', selectors: ['button[type="submit"]'], valueKey: null },
      { purpose: 'totp', selectors: ['input#code'], valueKey: 'totp' }
    ]
  },
  amazon: {
    platform: 'amazon',
    label: 'Amazon',
    loginUrl: 'https://www.amazon.com/ap/signin',
    successSelector: '#nav-your-account',
    fields: [
      { purpose: 'username', selectors: ['input#ap_email'], valueKey: 'username' },
      { purpose: 'password', selectors: ['input#ap_password'], valueKey: 'password' },
      { purpose: 'submit', selectors: ['input#signInSubmit'], valueKey: null },
      { purpose: 'totp', selectors: ['input#auth-mfa-otpcode'], valueKey: 'totp' }
    ]
  },
  github: {
    platform: 'github',
    label: 'GitHub',
    loginUrl: 'https://github.com/login',
    successSelector: null,
    fields: [
      { purpose: 'username', selectors: ['input#login_field'], valueKey: 'username' },
      { purpose: 'password', selectors: ['input#password'], valueKey: 'password' },
      { purpose: 'submit', selectors: ['input[type="submit"]'], valueKey: null },
      { purpose: 'totp', selectors: ['input[id^="otp"]'], valueKey: 'totp' }
    ]
  },
  other: {
    platform: 'other',
    label: '其它站点',
    loginUrl: null,
    successSelector: null,
    fields: [
      { purpose: 'username', selectors: ['input[type="email"]', 'input[name*="user"]', 'input[type="text"]'], valueKey: 'username' },
      { purpose: 'password', selectors: ['input[type="password"]'], valueKey: 'password' },
      { purpose: 'submit', selectors: ['button[type="submit"]'], valueKey: null },
      { purpose: 'totp', selectors: [], valueKey: 'totp' }
    ]
  }
}