import { getProfile, getFingerprint } from '../db/repositories/profiles'
import { createProfile, saveFingerprint } from '../db/repositories/profiles'
import { createProxy } from '../db/repositories/proxies'
import { assertFingerprintSavable } from './profiles'
import { newId } from '../lib/id'
import { log } from '../lib/log'
import type { ProfileBundle, PortImportResult } from '@shared/ops'

/**
 * 环境导入 / 导出（单环境完整迁移）。
 *
 * 导出内容：环境配置 + 指纹 + 绑定的代理（不含密码，密码无法跨设备解密）。
 * 登录态（cookie）单独走 session 模块的导出，这里只搬「配置」。
 *
 * 用途：换机器、备份单个环境、把一套调好的指纹分享给自己的另一个环境。
 */

export function exportBundle(profileId: string): ProfileBundle {
  const p = getProfile(profileId)
  if (!p) throw new Error(`环境不存在：${profileId}`)
  const fp = getFingerprint(profileId)
  return {
    version: 1,
    exportedAt: Date.now(),
    profile: {
      name: p.name,
      color: p.color,
      icon: p.icon,
      note: p.note,
      kernel: p.kernel,
      fingerprintMode: p.fingerprintMode,
      proxyMode: p.proxyMode,
      startupUrls: p.startupUrls,
      launchArgs: p.launchArgs,
      sessionPolicy: p.sessionPolicy,
      retention: p.retention,
      tags: p.tags
    },
    fingerprint: fp,
    proxy: p.proxy
      ? {
          name: p.proxy.name,
          scheme: p.proxy.scheme,
          host: p.proxy.host,
          port: p.proxy.port,
          username: p.proxy.username
        }
      : null
  }
}

export function importBundle(bundle: ProfileBundle, opts: { name?: string } = {}): PortImportResult {
  if (!bundle || bundle.version !== 1) throw new Error('不支持的备份格式版本')
  if (!bundle.profile || typeof bundle.profile.name !== 'string') throw new Error('备份缺少环境配置')
  // 先校验指纹再落库：畸形 bundle 不应留下一个「半创建」的环境
  if (bundle.fingerprint) assertFingerprintSavable(bundle.fingerprint)
  const name = opts.name ?? bundle.profile.name

  // 1. 代理：重新创建（密码留空，导入后用户自己补）
  let proxyId: string | null = null
  if (bundle.proxy) {
    const created = createProxy({
      name: bundle.proxy.name,
      scheme: bundle.proxy.scheme,
      host: bundle.proxy.host,
      port: bundle.proxy.port,
      username: bundle.proxy.username,
      password: null
    })
    proxyId = created.id
  }

  // 2. 环境
  const profile = createProfile({
    name,
    color: bundle.profile.color,
    icon: bundle.profile.icon,
    note: bundle.profile.note,
    kernel: bundle.profile.kernel,
    fingerprintMode: bundle.profile.fingerprintMode,
    proxyMode: bundle.proxy ? bundle.profile.proxyMode : 'none',
    proxyId,
    startupUrls: bundle.profile.startupUrls,
    launchArgs: bundle.profile.launchArgs,
    sessionPolicy: bundle.profile.sessionPolicy,
    retention: bundle.profile.retention,
    tags: bundle.profile.tags
  })

  // 3. 指纹：直接覆盖（保留原 seed，保证指纹完全一致）
  if (bundle.fingerprint) {
    saveFingerprint(profile.id, bundle.fingerprint)
  }

  log('port', `已导入环境「${name}」（新 id=${profile.id}${proxyId ? '，含代理' : ''}）`)
  return { profileId: profile.id, name, proxyCreated: Boolean(proxyId) }
}

/** 生成导出文件名 */
export function bundleFilename(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'profile'
  return `fpb-profile-${safe}-${newId('p')}.json`
}
