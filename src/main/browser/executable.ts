import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getSetting } from '../db/repositories/settings'

/**
 * 解析可用的 Chromium 可执行文件。
 * 1) 用户设置 chromiumExecutable
 * 2) playwright-core 自带注册表
 * 3) 扫描 ms-playwright 缓存目录
 */
function fromCache(): string | null {
  const root = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  if (!fs.existsSync(root)) return null
  const dirs = fs
    .readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  const arch = process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac'
  const names = ['Google Chrome for Testing', 'Chromium']
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(root, dir, arch, `${name}.app`, 'Contents', 'MacOS', name)
      if (fs.existsSync(candidate)) return candidate
    }
    const legacy = path.join(root, dir, arch, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    if (fs.existsSync(legacy)) return legacy
  }
  return null
}

/** 读取内核真实版本号，用于 auto 模式保证 UA 与 Client Hints 天然一致 */
export function detectKernelVersion(executablePath: string): string | null {
  const cached = getSetting<string>('kernelVersionCache', '')
  if (cached) return cached
  try {
    const appDir = executablePath.slice(0, executablePath.indexOf('.app') + 4)
    const out = require('node:child_process')
      .execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', `${appDir}/Contents/Info.plist`], {
        encoding: 'utf8'
      })
      .trim()
    if (/^\d+(\.\d+)+$/.test(out)) return out
  } catch {
    /* plutil 不可用时忽略 */
  }
  return null
}

/**
 * 正式版 Google Chrome 的常见安装位置。
 *
 * Playwright 缓存里的是 Chrome for Testing（未品牌化构建），它会弹
 * 「测试版本 / 建议更新」提示，而且缺少真实用户才有的媒体编解码与 Widevine。
 * 对指纹真实性来说，能用正式版就该优先用正式版。
 */
const BRANDED_CHROME: string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
]

/** 找到本机正式版 Chrome 就返回它，否则 null */
export function findBrandedChrome(): string | null {
  for (const p of BRANDED_CHROME) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    } catch {
      /* 权限或符号链接异常时跳过该候选 */
    }
  }
  return null
}

export function resolveChromiumExecutable(): string {
  const custom = getSetting<string>('chromiumExecutable', '')
  if (custom && fs.existsSync(custom)) return custom
  // 正式版 Chrome 排在 Playwright 缓存之前：没有测试版黄条，指纹也更接近真实用户
  if (getSetting<boolean>('preferBrandedChrome', true)) {
    const branded = findBrandedChrome()
    if (branded) return branded
  }
  try {
    // 延迟 require，避免在未安装浏览器时导入即抛错
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright-core') as typeof import('playwright-core')
    const p = chromium.executablePath()
    if (p && fs.existsSync(p)) return p
  } catch {
    /* fall through */
  }
  const cached = fromCache()
  if (cached) return cached
  throw new Error('未找到可用的 Chromium 内核，请在设置中指定 chromiumExecutable')
}
