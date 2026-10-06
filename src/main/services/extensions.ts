import fs from 'node:fs'
import path from 'node:path'
import {
  listExtensions,
  getExtension,
  getExtensionByPath,
  getExtensionByStoreId,
  createExtension,
  deleteExtension,
  setExtensionEnabled,
  bindExtensionToProfile,
  unbindExtensionFromProfile,
  getExtensionsForProfile,
  getProfilesForExtension,
  extensionUsageCounts,
  restoreExtension,
  purgeExtension,
  listTrashExtensions,
  emptyTrashExtensions
} from '../db/repositories/extensions'
import { logAudit } from '../db/repositories/settings'
import { log } from '../lib/log'
import { profileUserDataDir } from '../paths'
import type { ExtensionRecord } from '@shared/types'

/**
 * 扩展管理 service。
 *
 * 扩展以「解包目录」形式安装（Chrome --load-extension 只接受解包路径），
 * 安装时解析 manifest.json 获取 name / version / permissions / description。
 */

interface Manifest {
  name?: string
  version?: string
  description?: string
  permissions?: string[]
  manifest_version?: number
}

function readManifest(dirPath: string): Manifest {
  const manifestPath = path.join(dirPath, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`目录中未找到 manifest.json：${dirPath}`)
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest
  } catch (e) {
    throw new Error(`manifest.json 解析失败：${(e as Error).message}`)
  }
}

export function list(): ExtensionRecord[] {
  return listExtensions()
}

export function usage(): Record<string, number> {
  return extensionUsageCounts()
}

export function boundProfiles(extensionId: string): { id: string; name: string }[] {
  return getProfilesForExtension(extensionId)
}

export function install(dirPath: string): ExtensionRecord {
  const resolved = path.resolve(dirPath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`路径不存在或不是目录：${resolved}`)
  }
  // 检查是否已安装
  const existing = getExtensionByPath(resolved)
  if (existing) {
    throw new Error(`该扩展已安装（${existing.name}），无需重复添加`)
  }
  const manifest = readManifest(resolved)
  if (!manifest.name) {
    throw new Error('manifest.json 缺少 name 字段')
  }
  if (!manifest.manifest_version) {
    throw new Error('manifest.json 缺少 manifest_version 字段')
  }
  const record = createExtension({
    name: manifest.name,
    path: resolved,
    version: manifest.version ?? null,
    permissions: manifest.permissions ?? [],
    description: manifest.description ?? null
  })
  log('extensions', `已安装扩展「${record.name}」v${record.version ?? '?'} from ${resolved}`)
  logAudit('ext.install', 'extension', record.id, { name: record.name, path: resolved })
  return record
}

export function uninstall(id: string): { deleted: boolean; unbound: number } {
  const ext = getExtension(id)
  if (!ext) return { deleted: false, unbound: 0 }
  const profiles = getProfilesForExtension(id)
  deleteExtension(id)
  log('extensions', `已卸载扩展「${ext.name}」（移入回收站，保留 ${profiles.length} 个环境绑定）`)
  logAudit('ext.uninstall', 'extension', id, { name: ext.name, unbound: profiles.length })
  return { deleted: true, unbound: profiles.length }
}

/** 回收站列表 */
export function trash(): ExtensionRecord[] {
  return listTrashExtensions()
}

/** 从回收站恢复 */
export function restore(id: string): ExtensionRecord | null {
  restoreExtension(id)
  return getExtension(id)
}

/** 彻底删除（不可恢复） */
export function purge(id: string): void {
  purgeExtension(id)
  logAudit('ext.purge', 'extension', id)
}

/** 清空扩展回收站 */
export function emptyTrash(): number {
  return emptyTrashExtensions()
}

export function toggle(id: string, enabled: boolean): ExtensionRecord | null {
  setExtensionEnabled(id, enabled)
  logAudit('ext.toggle', 'extension', id, { enabled })
  return getExtension(id)
}

export function bind(extensionId: string, profileId: string): void {
  bindExtensionToProfile(extensionId, profileId)
  logAudit('ext.bind', 'extension', extensionId, { profileId })
}

export function unbind(extensionId: string, profileId: string): void {
  unbindExtensionFromProfile(extensionId, profileId)
  logAudit('ext.unbind', 'extension', extensionId, { profileId })
}

/** 供 launcher 调用：获取某环境应加载的扩展路径列表（仅解包扩展；商店扩展原生装在 profile 内，无需注入） */
export function pathsForProfile(profileId: string): string[] {
  return getExtensionsForProfile(profileId)
    .filter((e) => (e.source ?? 'unpacked') === 'unpacked')
    .map((e) => e.path)
}

// --- Chrome 应用商店扩展 ---

import { parseStoreId, guessNameFromUrl, storeUrlFor } from '../extensions/parse'

/** 通过 Chrome 应用商店链接 / ID 添加扩展（记录元数据；真正安装走 openStoreInstall 在环境内原生安装） */
export function installFromStore(urlOrId: string, name?: string): ExtensionRecord {
  const storeId = parseStoreId(urlOrId)
  const existing = getExtensionByStoreId(storeId)
  if (existing) {
    throw new Error(`该商店扩展已添加（${existing.name}），无需重复添加`)
  }
  const finalName = (name && name.trim()) || guessNameFromUrl(urlOrId, storeId)
  const record = createExtension({
    name: finalName,
    path: storeUrlFor(storeId),
    source: 'store',
    storeId
  })
  log('extensions', `已添加商店扩展「${record.name}」(${storeId})`)
  logAudit('ext.install.store', 'extension', record.id, { name: record.name, storeId })
  return record
}

/** 取某扩展的商店安装 URL（非商店扩展返回 null） */
export function getStoreUrl(extensionId: string): string | null {
  const ext = getExtension(extensionId)
  if (!ext || (ext.source ?? 'unpacked') !== 'store' || !ext.storeId) return null
  return storeUrlFor(ext.storeId)
}

/**
 * 检测某商店扩展是否已真正安装进指定环境的 user-data-dir。
 * Chrome 把已安装扩展落在 <user-data>/Default/Extensions/<storeId>/。
 * 解包扩展不走这里（它靠 --load-extension 注入，不落地到 profile）。
 */
export function isStoreInstalledInProfile(extensionId: string, profileId: string): boolean {
  const ext = getExtension(extensionId)
  if (!ext || (ext.source ?? 'unpacked') !== 'store' || !ext.storeId) return false
  const dir = path.join(profileUserDataDir(profileId), 'Default', 'Extensions', ext.storeId)
  return fs.existsSync(dir)
}

/** 某商店扩展在所有绑定环境里的安装状态 */
export function storeInstallStatus(extensionId: string): { profileId: string; name: string; installed: boolean }[] {
  return getProfilesForExtension(extensionId).map((p) => ({
    profileId: p.id,
    name: p.name,
    installed: isStoreInstalledInProfile(extensionId, p.id)
  }))
}