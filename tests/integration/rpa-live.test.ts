import { DEFAULT_RETENTION } from '@shared/session'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setDataDir, profileUserDataDir, ensureDir } from '../../src/main/paths'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { resolveChromiumExecutable, detectKernelVersion } from '../../src/main/browser/executable'
import { launchProfile, stopAllProfiles } from '../../src/main/browser/launcher'
import { getSession } from '../../src/main/browser/registry'
import { executeFlow } from '../../src/main/rpa/runner'
import { HUMANIZE_PRESETS, type HumanizeConfig } from '@shared/humanize'
import type { RpaFlow, StepLogEntry } from '@shared/rpa'
import type { Profile } from '@shared/types'

/**
 * M8 验收：RPA 流程在真实内核里跑通。
 * 用一个本地 HTML 页面而不是外部站点，保证断言确定、不依赖网络。
 */

let tmpDir = ''
let pageUrl = ''
let profile: Profile

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>RPA 测试页</title></head><body>
<h1>登录页</h1>
<input id="user" />
<input id="pass" type="password" />
<button id="login">登录</button>
<div id="status" style="display:none"></div>
<button id="more">加一条</button>
<ul id="list"></ul>
<div id="count">0</div>
<script>
document.getElementById('login').addEventListener('click', function () {
  var s = document.getElementById('status');
  s.textContent = '欢迎 ' + document.getElementById('user').value;
  s.style.display = 'block';
});
var n = 0;
document.getElementById('more').addEventListener('click', function () {
  n += 1;
  var li = document.createElement('li');
  li.textContent = 'item ' + n;
  document.getElementById('list').appendChild(li);
  document.getElementById('count').textContent = String(n);
});
// 迟到元素由流程里的 scheduleLate 步骤触发，计时起点才与前置步骤耗时无关
</script>
</body></html>`

function makeProfile(id: string): Profile {
  const exe = resolveChromiumExecutable()
  const fp = generateFingerprint({
    seed: 'rpa-live-seed',
    os: 'macOS',
    locale: 'en-US',
    timezone: 'Asia/Shanghai',
    kernelVersion: detectKernelVersion(exe) ?? '132.0.6834.110'
  })
  const ts = Date.now()
  return {
    id,
    name: 'rpa-live',
    groupId: null,
    color: null,
    icon: null,
    note: null,
    kernel: 'chromium',
    fingerprintMode: 'auto',
    proxyMode: 'none',
    proxyId: null,
    userDataDir: profileUserDataDir(id),
    startupUrls: [],
    launchArgs: [],
    sessionPolicy: 'keep',
    retention: DEFAULT_RETENTION,
    archived: 0,
    status: 'stopped',
    openCount: 0,
    lastOpenedAt: null,
    createdAt: ts,
    updatedAt: ts,
    tags: [],
    fingerprint: fp,
    proxy: null
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-rpa-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  const file = path.join(tmpDir, 'rpa-page.html')
  fs.writeFileSync(file, PAGE, 'utf8')
  pageUrl = pathToFileURL(file).href
  profile = makeProfile('rpa-live-1')
  await launchProfile({ profile, headless: true })
})

afterAll(async () => {
  await stopAllProfiles()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

async function runFlow(
  flow: RpaFlow,
  outDir: string,
  shouldStop?: () => boolean,
  onEvent?: (e: StepLogEntry) => void,
  humanize?: HumanizeConfig,
  seed?: string
) {
  const ctx = getSession(profile.id)!.context
  const page = await ctx.newPage()
  try {
    return await executeFlow({ flow, page, outDir, shouldStop, onEvent, humanize, seed })
  } finally {
    await page.close().catch(() => undefined)
  }
}

describe('RPA 流程执行（真实内核）', () => {
  it('完整流程：填表、断言、分支、循环、重试、截图、变量', async () => {
    const flow: RpaFlow = {
      version: 1,
      name: '主流程',
      defaultTimeoutMs: 5000,
      params: { username: 'alice' },
      steps: [
        { id: 'open', type: 'goto', url: pageUrl },
        { id: 'title', type: 'assertText', expected: '登录页', mode: 'contains' },
        { id: 'u', type: 'fill', selector: '#user', value: '${username}' },
        { id: 'p', type: 'fill', selector: '#pass', value: 'hunter2' },
        { id: 'login', type: 'click', selector: '#login' },
        { id: 'waitStatus', type: 'wait', selector: '#status', state: 'visible' },
        { id: 'grab', type: 'text', selector: '#status', variable: 'greeting' },
        {
          id: 'branch',
          type: 'if',
          condition: "$greeting == '欢迎 alice'",
          then: [{ id: 'then1', type: 'setVariable', name: 'branchTaken', value: 'then' }],
          else: [{ id: 'else1', type: 'setVariable', name: 'branchTaken', value: 'else' }]
        },
        {
          // 计时起点放在紧邻的上一步：这样「迟到」与前面步骤耗时无关，测试不会因机器快慢而假过
          id: 'scheduleLate',
          type: 'evaluate',
          expression:
            "setTimeout(function(){var d=document.createElement('div');d.id='lateReady';d.textContent='迟到元素';document.body.appendChild(d);},600);'scheduled'",
          variable: 'scheduled'
        },
        { id: 'late', type: 'wait', selector: '#lateReady', state: 'visible', timeoutMs: 200, onError: 'retry', retryCount: 3, retryDelayMs: 300 },
        {
          id: 'loop',
          type: 'loop',
          times: 5,
          untilCondition: '$n == 3',
          intervalMs: 20,
          steps: [
            { id: 'more', type: 'click', selector: '#more' },
            { id: 'bump', type: 'evaluate', expression: "String(document.querySelectorAll('#list li').length)", variable: 'n' }
          ]
        },
        { id: 'countText', type: 'text', selector: '#count', variable: 'countShown' },
        { id: 'assertCount', type: 'assertText', selector: '#count', expected: '3', mode: 'equals' },
        { id: 'shot', type: 'screenshot', filename: 'final.png' },
        { id: 'off', type: 'log', message: '不该执行', enabled: false }
      ]
    }

    // 人类化关闭：这条用例测的是流程语义（分支/循环/重试），要快且确定
    const out = await runFlow(flow, path.join(tmpDir, 'run-main'), undefined, undefined, HUMANIZE_PRESETS.off)

    expect(out.error).toBeNull()
    expect(out.status).toBe('success')
    expect(out.stats.failed).toBe(0)
    expect(out.vars.greeting).toBe('欢迎 alice')
    expect(out.vars.branchTaken).toBe('then')
    expect(out.vars.n).toBe('3')
    expect(out.vars.countShown).toBe('3')
    // 单步重试确实生效过：迟到元素 500ms 后才出现，而该步超时只有 200ms
    expect(out.stats.retried).toBeGreaterThanOrEqual(1)
    expect(out.log.some((l) => l.stepId === 'late' && l.status === 'retrying')).toBe(true)
    // 走的是 then 分支，else 里的步骤不应出现
    expect(out.log.some((l) => l.stepId === 'else1')).toBe(false)
    // 被禁用的步骤记为 skipped
    expect(out.stats.skipped).toBe(1)
    // 嵌套步骤带层级，日志界面才能缩进
    expect(out.log.find((l) => l.stepId === 'more')?.depth).toBeGreaterThanOrEqual(1)
    // 截图落在本次运行目录里
    expect(out.files).toHaveLength(1)
    expect(out.files[0]).toContain('final.png')
    expect(fs.existsSync(out.files[0])).toBe(true)
  }, 120000)

  it('选择器写错：默认停止后续步骤，并给出可定位的错误', async () => {
    const flow: RpaFlow = {
      version: 1,
      name: '失败流程',
      defaultTimeoutMs: 800,
      steps: [
        { id: 'open', type: 'goto', url: pageUrl },
        { id: 'bad', type: 'click', selector: '#not-exist' },
        { id: 'never', type: 'log', message: '不该跑到这里' }
      ]
    }
    const out = await runFlow(flow, path.join(tmpDir, 'run-fail'))
    expect(out.status).toBe('failed')
    expect(out.stats.failed).toBe(1)
    expect(out.error).toContain('#not-exist')
    expect(out.log.some((l) => l.stepId === 'never')).toBe(false)
    expect(out.log.find((l) => l.stepId === 'bad')?.status).toBe('failed')
  }, 60000)

  it('onError=continue：单步失败不影响后续步骤', async () => {
    const flow: RpaFlow = {
      version: 1,
      name: '容错流程',
      defaultTimeoutMs: 800,
      steps: [
        { id: 'open', type: 'goto', url: pageUrl },
        { id: 'bad', type: 'click', selector: '#not-exist', onError: 'continue' },
        { id: 'still', type: 'assertText', expected: '登录页', mode: 'contains' }
      ]
    }
    const out = await runFlow(flow, path.join(tmpDir, 'run-continue'))
    expect(out.status).toBe('success')
    expect(out.stats.failed).toBe(1)
    expect(out.stats.ok).toBeGreaterThanOrEqual(2)
    expect(out.log.some((l) => l.stepId === 'still' && l.status === 'ok')).toBe(true)
  }, 60000)

  it('文本断言失败会把期望与实际都写进日志', async () => {
    const flow: RpaFlow = {
      version: 1,
      name: '断言失败',
      defaultTimeoutMs: 2000,
      steps: [
        { id: 'open', type: 'goto', url: pageUrl },
        { id: 'assert', type: 'assertText', expected: '完全不同的文案', mode: 'contains' }
      ]
    }
    const out = await runFlow(flow, path.join(tmpDir, 'run-assert'))
    expect(out.status).toBe('failed')
    const entry = out.log.find((l) => l.stepId === 'assert')
    expect(entry?.message).toContain('完全不同的文案')
    expect(entry?.message).toContain('登录页')
  }, 60000)

  it('外部请求停止时立即中断，状态记为 stopped', async () => {
    // 用事件计数而不是结果对象来判断：结果对象在运行结束前还不存在（TDZ）
    let clicks = 0
    const flow: RpaFlow = {
      version: 1,
      name: '被停止的流程',
      defaultTimeoutMs: 5000,
      steps: [
        { id: 'open', type: 'goto', url: pageUrl },
        { id: 'loop', type: 'loop', times: 50, intervalMs: 50, steps: [{ id: 'more', type: 'click', selector: '#more' }] }
      ]
    }
    const out = await runFlow(
      flow,
      path.join(tmpDir, 'run-stop'),
      () => clicks >= 3,
      (e) => {
        if (e.stepId === 'more' && e.status === 'ok') clicks += 1
      }
    )
    expect(out.status).toBe('stopped')
    expect(out.log.filter((l) => l.stepId === 'more').length).toBeLessThan(50)
    expect(out.log.filter((l) => l.stepId === 'more').length).toBeGreaterThanOrEqual(3)
  }, 60000)

  it('人类化：真实内核里确实产生了鼠标轨迹、点击间隔与逐字符输入事件', async () => {
    // 在页面里记录所有输入事件与时间戳：这是目标站点风控实际能看到的东西
    const ctx = getSession(profile.id)!.context
    const page = await ctx.newPage()
    await page.addInitScript(`
      window.__ev = [];
      window.addEventListener('DOMContentLoaded', function () {
        var kinds = ['mousemove','mousedown','mouseup','click','keydown','keyup','input','textInput'];
        kinds.forEach(function (k) {
          document.addEventListener(k, function (e) {
            window.__ev.push({ k: k, t: e.timeStamp, x: e.clientX, y: e.clientY, key: e.key || null });
          }, true);
        });
      });
    `)
    await page.goto(pageUrl, { waitUntil: 'load' })
    await page.evaluate(`window.__ev = [];`)

    // 收紧时间范围，保证测试不慢；但保留「逐字输入 / 曲线移动 / 随机落点」这些行为本身
    const hz: HumanizeConfig = {
      ...HUMANIZE_PRESETS.standard,
      mouseSteps: [10, 16],
      mouseDurationMs: [60, 140],
      preClickDwellMs: [20, 60],
      clickHoldMs: [25, 60],
      charDelayMs: [12, 40],
      preTypeDwellMs: [20, 60],
      actionGapMs: [10, 40]
    }
    const flow: RpaFlow = {
      version: 1,
      name: '人类化流程',
      defaultTimeoutMs: 5000,
      steps: [
        { id: 'u', type: 'fill', selector: '#user', value: 'alice' },
        { id: 'login', type: 'click', selector: '#login' }
      ]
    }
    const out = await executeFlow({ flow, page, outDir: path.join(tmpDir, 'run-hz'), humanize: hz, seed: 'hz-fixed' })
    expect(out.error).toBeNull()

    const ev = (await page.evaluate('window.__ev')) as { k: string; t: number; x: number; y: number; key: string | null }[]
    const moves = ev.filter((e) => e.k === 'mousemove')
    const downs = ev.filter((e) => e.k === 'mousedown')
    const ups = ev.filter((e) => e.k === 'mouseup')
    const keydowns = ev.filter((e) => e.k === 'keydown')
    const inputs = ev.filter((e) => e.k === 'input')

    // 1) 必须有鼠标轨迹：Playwright 原生 click 是 0 个 mousemove
    expect(moves.length).toBeGreaterThanOrEqual(8)
    // 2) 轨迹不能是直线：相邻向量的方向必须变化
    const dirs: number[] = []
    for (let i = 2; i < moves.length; i += 1) {
      dirs.push(Math.atan2(moves[i].y - moves[i - 1].y, moves[i].x - moves[i - 1].x))
    }
    const distinctDirs = new Set(dirs.map((d) => Math.round(d * 20)))
    expect(distinctDirs.size).toBeGreaterThanOrEqual(2)
    // 3) 时间戳必须单调不减，且整条轨迹跨时 > 0
    for (let i = 1; i < ev.length; i += 1) expect(ev[i].t).toBeGreaterThanOrEqual(ev[i - 1].t)
    // 4) 按下与抬起之间必须有真实间隔（原生 click 是同一时刻）
    //    两次按下：fill 的聚焦点击 + login 的点击 —— 两者都必须是人类化的
    expect(downs.length).toBe(2)
    expect(ups.length).toBe(2)
    for (let i = 0; i < downs.length; i += 1) expect(ups[i].t - downs[i].t).toBeGreaterThan(0)
    // 5) 逐字符输入：5 个字符应产生 5 次 keydown / input，而不是 1 次整体赋值
    expect(keydowns.length).toBeGreaterThanOrEqual(5)
    expect(inputs.length).toBeGreaterThanOrEqual(5)
    const typed = keydowns.filter((k) => k.key && k.key.length === 1).map((k) => k.key).join('')
    expect(typed).toContain('alice')
    // 6) 两次落点都不能正好是元素正中（正中命中是机器人特征）
    const loginBox = (await page.locator('#login').boundingBox())!
    const userBox = (await page.locator('#user').boundingBox())!
    const offCenter = (p: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }): number =>
      Math.abs(p.x - (box.x + box.width / 2)) + Math.abs(p.y - (box.y + box.height / 2))
    expect(offCenter(downs[0], userBox)).toBeGreaterThan(0.01)
    expect(offCenter(downs[1], loginBox)).toBeGreaterThan(0.01)
    // 7) 日志里记录了实际落点，便于事后核对
    expect(out.log.find((l) => l.stepId === 'login')?.message).toMatch(/已点击 #login @\(/)

    await page.close().catch(() => undefined)
  }, 60000)

  it('固定 seed 时鼠标轨迹与打字节奏可复现', async () => {
    const hz = { ...HUMANIZE_PRESETS.standard, actionGapMs: [0, 0] as [number, number] }
    // 每次 runFlow 都开新页面，所以流程必须自己导航到测试页
    const steps = [
      { id: 'open', type: 'goto', url: pageUrl } as const,
      { id: 'c', type: 'click', selector: '#more' } as const
    ]
    const a = await runFlow(
      { version: 1, name: 'seed-a', defaultTimeoutMs: 5000, steps },
      path.join(tmpDir, 'run-seed-a'),
      undefined,
      undefined,
      hz,
      'same-seed'
    )
    const b = await runFlow(
      { version: 1, name: 'seed-b', defaultTimeoutMs: 5000, steps },
      path.join(tmpDir, 'run-seed-b'),
      undefined,
      undefined,
      hz,
      'same-seed'
    )
    const pt = (r: { log: StepLogEntry[] }): string | undefined => r.log.find((l) => l.stepId === 'c')?.message.match(/@\(([-\d.]+), ([-\d.]+)\)/)?.[0]
    expect(a.error, a.error ?? '').toBeNull()
    expect(pt(a)).toBeTruthy()
    expect(pt(a)).toBe(pt(b))
  }, 60000)
})