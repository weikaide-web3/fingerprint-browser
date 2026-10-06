import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getSetting } from '../db/repositories/settings'
import { resolveChromiumExecutable, detectKernelVersion, findBrandedChrome } from '../browser/executable'
import { chromeMajor } from '../tls/baseline'
import type { KernelFlavor, KernelIdentity, KernelSource } from '@shared/kernel'

/**
 * 内核身份识别。
 *
 * 「我们用的是哪个内核」不是小事：正式版 Chrome、Chrome for Testing、
 * Playwright 的 Chromium 与自编译补丁内核，在媒体能力、更新通道、
 * Widevine、以及「能不能扛内核级验证」上完全不同。检测页必须把这一层
 * 显示出来，否则用户会以为指纹差异是自己配置错了。
 */

/** 补丁内核在页面里暴露的全局名；官方内核没有它，因此可以据此判定补丁是否生效 */
export const MARKER_GLOBAL = '__fpbKernel'

/** 我们自己的补丁构建约定的 bundle 标识前缀 */
export const PATCHED_BUNDLE_PREFIX = 'com.fingerprintbrowser'

function appDirOf(executable: string): string {
  const i = executable.indexOf('.app')
  return i < 0 ? '' : executable.slice(0, i + 4)
}

function readPlist(executable: string): { name: string; id: string } {
  const dir = appDirOf(executable)
  if (!dir) return { name: '', id: '' }
  const plist = path.join(dir, 'Contents', 'Info.plist')
  if (!fs.existsSync(plist)) return { name: '', id: '' }
  const pick = (key: string): string => {
    try {
      return execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }
  return { name: pick('CFBundleName'), id: pick('CFBundleIdentifier') }
}

/**
 * 纯函数：由 bundle 名 / bundle id / 路径判定内核种类。
 * 单独拆出来是为了能脱离本机内核做单测（CI 上不一定装了 Chrome）。
 */
export function classify(
  executable: string,
  bundleName: string,
  bundleId: string
): { flavor: KernelFlavor; branded: boolean; patched: boolean } {
  const name = String(bundleName || '')
  const id = String(bundleId || '')
  const lower = `${name} ${executable}`.toLowerCase()

  if (id.startsWith(PATCHED_BUNDLE_PREFIX) || /fingerprintbrowser|fpb-chrome/.test(lower)) {
    return { flavor: 'patched', branded: false, patched: true }
  }
  if (/chrome for testing/.test(lower)) return { flavor: 'chrome-for-testing', branded: false, patched: false }
  if (/^google chrome/.test(name) || /google chrome( beta| canary)?\.app/.test(lower)) {
    return { flavor: 'branded-chrome', branded: true, patched: false }
  }
  if (name === 'Chromium' || /chromium\.app/.test(lower)) return { flavor: 'chromium', branded: false, patched: false }
  return { flavor: 'unknown', branded: false, patched: false }
}

/** 判定当前实际会被启动的内核来自哪个来源 */
function resolveSource(executable: string): KernelSource {
  const custom = String(getSetting<string>('chromiumExecutable', '') ?? '')
  if (custom && executable === custom) return 'setting'
  if (findBrandedChrome() === executable) return 'branded'
  const root = path.join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
  if (executable.startsWith(root)) return 'cache'
  return 'playwright'
}

export interface KernelIdentityOptions {
  /** 覆盖可执行文件路径（测试用） */
  executable?: string
  /** 补丁内核页面标记（由探测写入；未探测时为 null） */
  marker?: string | null
}

export function kernelIdentity(opts: KernelIdentityOptions = {}): KernelIdentity {
  let executable = opts.executable ?? ''
  if (!executable) {
    try {
      executable = resolveChromiumExecutable()
    } catch {
      executable = ''
    }
  }
  if (!executable) {
    return {
      path: '',
      flavor: 'unknown',
      version: 'unknown',
      major: null,
      branded: false,
      patched: false,
      patchLevel: 0,
      marker: opts.marker ?? null,
      source: 'none',
      bundleName: '',
      bundleId: ''
    }
  }

  const { name, id } = readPlist(executable)
  const kind = classify(executable, name, id)
  const version = detectKernelVersion(executable) ?? 'unknown'
  // 补丁级别：优先信页面标记（最可靠，证明补丁真的编译进去了），
  // 其次信 bundle 约定（编译时改的）。两者都没有就是官方内核。
  const marker = opts.marker ?? null
  const fromMarker = marker ? Number(/level=(\d+)/.exec(marker)?.[1] ?? 1) : 0
  const patchLevel = kind.patched || fromMarker > 0 ? Math.max(1, fromMarker) : 0

  return {
    path: executable,
    flavor: kind.patched ? 'patched' : kind.flavor,
    version,
    major: version === 'unknown' ? null : chromeMajor(version),
    branded: kind.branded,
    patched: patchLevel > 0,
    patchLevel,
    marker,
    source: resolveSource(executable),
    bundleName: name,
    bundleId: id
  }
}