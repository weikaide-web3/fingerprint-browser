import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { withContext } from '../browser/with-context'
import { awaitPageInjection } from '../fingerprint/injector'
import { getSession } from '../browser/registry'
import { getProfile } from '../db/repositories/profiles'
import { compareSignals, summarize, type Snapshot } from '../detect/compare'
import { PROBE_FILENAME, PROBE_HTML } from '../detect/probe'
import { kernelIdentity } from '../kernel/identity'
import { dataDir, ensureDir } from '../paths'
import { typedSetting } from '../settings/defs'
import { log, logError } from '../lib/log'
import type { DetectItem, DetectReport } from '@shared/detect'

/**
 * 指纹检测：在真实内核里跑一遍内置探针页，把实测信号与 profile 期望逐项比对。
 *
 * 采两次样：Canvas / Audio 噪声必须由 seed 决定，两次不一致说明噪声在漂移，
 * 那意味着同一个环境每次访问都会被判定成新设备 —— 这是比「某项没生效」更隐蔽的问题。
 */

function probeUrl(headless: boolean): string {
  const dir = ensureDir(path.join(dataDir(), 'detect'))
  const file = path.join(dir, PROBE_FILENAME)
  // 每次都覆盖，保证升级后探针与注入层同步
  fs.writeFileSync(file, PROBE_HTML, 'utf8')
  // 把「有没有真实窗口」告诉探针：headless 下 outer==inner 是内核行为，
  // 不该被当成「注入层只改了一半」来判失败。
  return `${pathToFileURL(file).href}?headed=${headless ? '0' : '1'}`
}

function emptyReport(profileId: string, name: string, error: string): DetectReport {
  return {
    profileId,
    name,
    collectedAt: Date.now(),
    samples: 0,
    items: [],
    ok: 0,
    mismatch: 0,
    unknown: 0,
    score: 0,
    snapshot: {},
    error,
    kernel: kernelIdentity()
  }
}

/** 补丁内核暴露的标记可能是字符串或对象，统一成字符串便于展示与解析 level */
function markerOf(snapshot: Snapshot): string | null {
  const m = snapshot.kernelMarker
  if (m === undefined || m === null) return null
  return typeof m === 'string' ? m : JSON.stringify(m)
}

export async function runDetection(profileId: string, opts: { samples?: number } = {}): Promise<DetectReport> {
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`环境不存在：${profileId}`)
  const fp = profile.fingerprint
  if (!fp) return emptyReport(profileId, profile.name, '该环境还没有指纹配置，无法比对')

  const wanted = opts.samples ?? typedSetting<number>('detectSamples', 2)
  const samples = Math.max(1, Math.min(wanted, 3))
  const collected: Snapshot[] = []
  await withContext(profileId, '采集指纹信号', async (ctx) => {
    const session = getSession(profileId)
    const url = probeUrl(session?.headless ?? false)
    for (let i = 0; i < samples; i += 1) {
      const page = await ctx.newPage()
      try {
        // 先等 CDP 覆盖落地，否则探针采到的是内核默认 UA/CH/时区，比对会假性 mismatch
        await awaitPageInjection(page)
        await page.goto(url, { waitUntil: 'load', timeout: 30000 })
        // UA / 时区 / locale 是 CDP 异步下发的，等覆盖落地再采样，否则会采到内核默认值
        await page.waitForTimeout(400)
        const snapshot = (await page.evaluate('window.__fpCollect()')) as Snapshot | null
        if (!snapshot) throw new Error('探针未返回信号')
        // 把「我们请求的窗口尺寸」与「窗口管理器真正落地的尺寸」带进快照：
        // 两者不等说明显示器放不下配置尺寸，检测页据此把它报成「未采集/受限」
        // 而不是「注入撒谎」—— 这是两种完全不同的问题。
        const wb = getSession(profileId)?.windowBounds
        if (wb) snapshot.__windowBounds = wb
        collected.push(snapshot)
      } catch (e) {
        logError('detect', `第 ${i + 1} 次采样失败`, e)
        throw e
      } finally {
        await page.close().catch(() => undefined)
      }
    }
  })

  const items: DetectItem[] = compareSignals(fp, collected[0], collected[1])
  const sum = summarize(items)
  log('detect', `${profile.name} 检测完成：${sum.ok} 项一致 / ${sum.mismatch} 项不一致 / score=${sum.score}`)
  return {
    profileId,
    name: profile.name,
    collectedAt: Date.now(),
    samples: collected.length,
    items,
    ok: sum.ok,
    mismatch: sum.mismatch,
    unknown: sum.unknown,
    score: sum.score,
    snapshot: collected[0],
    error: null,
    // 带上页面里读到的补丁标记：官方内核没有它，因此这能证明补丁真的编译进内核了
    kernel: kernelIdentity({ marker: markerOf(collected[0]) })
  }
}