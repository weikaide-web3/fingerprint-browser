import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountSecrets,
  touchAccount,
  accountCountByProfile,
  accountProfileConflicts
} from '../db/repositories/accounts'
import { totp } from '../totp'
import { log } from '../lib/log'
import { AUTOFILL_PRESETS } from '@shared/account'
import type { AccountInput, AccountRecord, AutofillPreset, AutofillPlan, AutofillPlanField, TotpCodeView } from '@shared/account'

export type { AccountInput, AccountRecord, TotpCodeView }

export function list(profileId?: string): AccountRecord[] {
  return listAccounts(profileId)
}

export function get(id: string): AccountRecord | null {
  return getAccount(id)
}

export function create(input: AccountInput): AccountRecord {
  const created = createAccount(input)
  log('account', `新增账号 ${created.username} @ ${created.platform}（${created.totpKind}）`)
  return created
}

export function update(id: string, patch: Partial<AccountInput>): AccountRecord | null {
  const updated = updateAccount(id, patch)
  if (updated) log('account', `更新账号 ${updated.username} @ ${updated.platform}`)
  return updated
}

export function remove(id: string): boolean {
  const a = getAccount(id)
  if (!a) return false
  deleteAccount(id)
  log('account', `删除账号 ${a.username} @ ${a.platform}`)
  return true
}

export function countsByProfile(): Record<string, number> {
  return accountCountByProfile()
}

/** 同账号绑到多个环境的风险清单 */
export function conflicts(): ReturnType<typeof accountProfileConflicts> {
  return accountProfileConflicts()
}

/**
 * 生成当前 TOTP 码。
 *
 * 只返回一次性验证码本身，绝不把密钥带回渲染进程：验证码 30 秒就作废，
 * 而密钥泄露等于永久失守。
 */
export function currentTotpCode(accountId: string): TotpCodeView {
  const account = getAccount(accountId)
  if (!account) throw new Error(`账号不存在：${accountId}`)
  if (!account.hasTotp) throw new Error(`${account.username} 没有配置 TOTP 密钥（短信验证无法自动生成）`)
  const secrets = getAccountSecrets(accountId)
  if (!secrets?.totpSecret) throw new Error('TOTP 密钥无法解密，请重新录入密钥')
  const r = totp(secrets.totpSecret)
  return {
    accountId,
    code: r.code,
    digits: r.digits,
    periodSeconds: r.periodSeconds,
    remainingSeconds: r.remainingSeconds,
    generatedAt: Date.now()
  }
}

export function presetFor(platform: AccountRecord['platform']): AutofillPreset {
  return AUTOFILL_PRESETS[platform] ?? AUTOFILL_PRESETS.other
}

/**
 * 生成填充计划（不执行）。
 *
 * 刻意把「计划」与「执行」分开：计划可以展示给用户确认、可以在 UI 里
 * 高亮将要填哪个框，而机密只在执行的一瞬间进入内存。
 */
export function buildAutofillPlan(accountId: string, opts: { includeTotp?: boolean } = {}): AutofillPlan {
  const account = getAccount(accountId)
  if (!account) throw new Error(`账号不存在：${accountId}`)
  const preset = presetFor(account.platform)
  const secrets = getAccountSecrets(accountId)
  const values: Record<string, string | null> = {
    username: account.email || account.username,
    email: account.email,
    password: secrets?.password ?? null,
    totp: null
  }
  if (opts.includeTotp && account.hasTotp && secrets?.totpSecret) {
    values.totp = totp(secrets.totpSecret).code
  }

  const warnings: string[] = []
  if (!values.password) warnings.push('该账号没有保存密码，密码框将留空')
  if (account.totpKind === 'sms') warnings.push('该账号使用短信验证，无法自动生成，需要人工接收')
  if (account.totpKind === 'totp' && !opts.includeTotp) warnings.push('已配置 TOTP，但未启用自动填充验证码')

  const steps: AutofillPlanField[] = []
  for (const field of preset.fields) {
    const value = field.valueKey ? values[field.valueKey] ?? null : null
    if (field.valueKey === 'totp' && !values.totp) continue
    if (field.selectors.length === 0) {
      if (field.purpose !== 'submit') warnings.push(`${preset.label} 的 ${field.purpose} 字段没有预设选择器，需要手动处理`)
      continue
    }
    steps.push({ purpose: field.purpose, selector: field.selectors[0], value })
  }

  return {
    accountId,
    username: account.username,
    platform: account.platform,
    loginUrl: preset.loginUrl,
    successSelector: preset.successSelector,
    steps,
    warnings
  }
}

export function markUsed(accountId: string): void {
  touchAccount(accountId)
}