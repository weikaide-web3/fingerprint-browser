import * as repo from '../db/repositories/profiles'
import * as proxiesRepo from '../db/repositories/proxies'
import { deleteSetting } from '../db/repositories/settings'
import { generateFingerprint } from '../fingerprint/generator'
import { blockingIssues, validateFingerprint } from '../fingerprint/consistency'
import type { ConsistencyReport, SessionPolicy } from '@shared/types'
import { resolveChromiumExecutable, detectKernelVersion } from '../browser/executable'
import { getStatus } from '../browser/registry'
import { typedSetting } from '../settings/defs'
import { logError } from '../lib/log'
import type { FingerprintConfig, Profile, ProfileFilter, ProfileInput, ListResult } from '@shared/types'

/** 创建环境：未显式提供指纹时自动生成（auto 模式对齐内核真实版本） */
export function create(input: ProfileInput): Profile {
  const payload: ProfileInput = { ...input }
  // 新建环境默认继承全局登录态策略，省得每个环境都要手点一遍
  if (!payload.sessionPolicy) payload.sessionPolicy = typedSetting<SessionPolicy>('defaultSessionPolicy', 'keep')
  if (payload.fingerprint) assertFingerprintSavable(payload.fingerprint)
  if (!payload.fingerprint && !payload.cloneFrom) {
    const proxy = payload.proxyId ? proxiesRepo.getProxy(payload.proxyId) : null
    payload.fingerprint = generateFingerprint({
      seed: payload.fingerprintOptions?.seed,
      os: payload.fingerprintOptions?.os ?? 'macOS',
      locale: payload.fingerprintOptions?.locale,
      timezone: payload.fingerprintOptions?.timezone,
      kernelVersion: kernelVersion(),
      mode: payload.fingerprintMode ?? 'auto',
      ip: proxy
        ? { country: proxy.country ?? undefined, timezone: proxy.timezone ?? undefined, ip: proxy.ip ?? undefined }
        : null
    })
  }
  return repo.createProfile(payload)
}

export function kernelVersion(): string | undefined {
  try {
    return detectKernelVersion(resolveChromiumExecutable()) ?? undefined
  } catch (e) {
    logError('fingerprint', '无法读取内核版本，使用数据集版本', e)
    return undefined
  }
}

export function list(filter: ProfileFilter = {}): ListResult<Profile> {
  const result = repo.listProfiles(filter)
  for (const item of result.items) item.status = getStatus(item.id)
  return result
}

export function get(id: string): Profile | null {
  const profile = repo.getProfile(id)
  if (profile) profile.status = getStatus(id)
  return profile
}

export function update(id: string, patch: Partial<ProfileInput>): Profile | null {
  if (patch.fingerprint) assertFingerprintSavable(patch.fingerprint)
  return repo.updateProfile(id, patch)
}

export function remove(id: string): void {
  repo.deleteProfile(id)
}

/** 回收站列表 */
export function trash(): Profile[] {
  return repo.listTrashProfiles()
}

/** 从回收站恢复 */
export function restore(id: string): void {
  repo.restoreProfile(id)
}

/** 彻底删除（不可恢复） */
export function purge(id: string): void {
  repo.purgeProfile(id)
  // 漂移基线存在 settings 表里，没有外键级联，必须显式清理，否则永远残留
  deleteSetting(`driftBaseline:${id}`)
}

/** 清空环境回收站 */
export function emptyTrash(): number {
  const ids = repo.listTrashProfiles().map((p) => p.id)
  const n = repo.emptyTrashProfiles()
  for (const id of ids) deleteSetting(`driftBaseline:${id}`)
  return n
}

export function duplicate(id: string, name: string): Profile | null {
  return repo.duplicateProfile(id, name)
}

export function regenerateFingerprint(id: string, seed?: string): FingerprintConfig | null {
  const profile = repo.getProfile(id)
  if (!profile) return null
  const previous = repo.getFingerprint(id)
  const config = generateFingerprint({
    seed,
    os: previous?.ua.os ?? 'macOS',
    locale: previous?.language.intlLocale,
    timezone: previous?.timezone.id,
    kernelVersion: kernelVersion(),
    mode: profile.fingerprintMode,
    ip: profile.proxy
      ? { country: profile.proxy.country ?? undefined, timezone: profile.proxy.timezone ?? undefined, ip: profile.proxy.ip ?? undefined }
      : null
  })
  repo.saveFingerprint(id, config)
  return config
}

export function setFingerprint(id: string, config: FingerprintConfig): void {
  assertFingerprintSavable(config)
  repo.saveFingerprint(id, config)
}

/**
 * 保存前硬拦截：只拦「UA 与真实内核互相打脸」这类硬伤。
 *
 * 为什么不是「有 error 就拒绝」：体检里很多 error 是配置内部矛盾（比如屏幕方向），
 * 用户可能有意为之；但 UA 版本与内核实测版本不一致会直接毁掉 TLS/HTTP2 与
 * X 的 x-client-transaction-id 关联，属于「保存了就一定废」的配置，
 * 所以宁可拒绝并给出可执行的修法，也不要让用户带着它去登录账号。
 */
export function assertFingerprintSavable(fp: FingerprintConfig): void {
  if (fp.ua.browser !== 'Chrome' && fp.ua.browser !== 'Edge') return
  const report = validateFingerprint(fp, { kernelVersion: kernelVersion() ?? null })
  const blocking = blockingIssues(report)
  if (!blocking.length) return
  throw new Error(
    `指纹无法保存：${blocking.map((i) => i.message).join('；')}。` +
      '可在环境详情里点「重新生成」让 UA 自动对齐当前内核，或在设置里指定与 UA 匹配的内核路径。'
  )
}

/**
 * 一致性体检：除了指纹自身，还要把绑定代理的出口 IP / 时区带进上下文，
 * 否则「时区在东京、出口 IP 在洛杉矶」这类跨模块矛盾查不出来。
 */
export function validateProfileFingerprint(id: string): ConsistencyReport | null {
  const profile = repo.getProfile(id)
  if (!profile) return null
  const fp = repo.getFingerprint(id)
  if (!fp) {
    return {
      issues: [{ level: 'warn', code: 'NO_FINGERPRINT', message: '该环境还没有指纹配置', fields: ['fingerprint'] }],
      score: 0,
      errors: 0,
      warns: 1,
      infos: 0
    }
  }
  return validateFingerprint(fp, {
    proxyIp: profile.proxy?.ip ?? null,
    proxyTimezone: profile.proxy?.timezone ?? null,
    kernelVersion: kernelVersion() ?? null
  })
}

export function getFingerprintFor(id: string): FingerprintConfig | null {
  return repo.getFingerprint(id)
}
