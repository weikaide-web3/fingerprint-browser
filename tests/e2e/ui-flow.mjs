/**
 * UI 端到端验证：
 *   新建环境 -> 打开内核 -> 停止 -> 换指纹
 *   -> 环境详情：改名 / 备注 / 分组 / 一致性体检 / 重新生成指纹
 *   -> 新增代理 -> IP 检测 -> 绑定环境 -> 打开内核并确认流量真的经过代理
 *   -> 带认证代理走本机 relay -> 删除 -> 侧边栏导航
 *
 * 运行：node tests/e2e/ui-flow.mjs
 * 前置：npm run build
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const PORT = 9333
const SHOT = '/tmp/fpb-ui.png'

function waitForDevTools(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            retry()
          }
        })
      })
      req.on('error', retry)
      req.on('timeout', () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('Electron DevTools 未就绪'))
      setTimeout(tick, 300)
    }
    tick()
  })
}

/** 假出口服务：浏览器穿过代理访问它，返回一个可识别的标记 */
function startOrigin(marker) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      // 同时满足两件事：给浏览器看的 marker，和给「检测」用的 ip-api 形状
      const body = JSON.stringify({
        marker,
        status: 'success',
        query: '203.0.113.77',
        country: 'US',
        regionName: 'California',
        city: 'Mountain View',
        isp: 'E2E Fake',
        timezone: 'America/Los_Angeles'
      })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }))
  })
}

/**
 * 假 HTTP 代理：同时处理 CONNECT 与 absolute-form 明文请求
 * （Chrome 对 http:// 走 absolute-form，对 https:// 走 CONNECT），
 * 并把每一次转发记进 log —— 这就是「内核确实经过代理」的证据。
 */
function startFakeProxy(auth) {
  const log = []
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const sep = buf.indexOf('\r\n\r\n')
      if (sep < 0) return
      const head = buf.subarray(0, sep).toString('latin1')
      const rest = buf.subarray(sep + 4)
      sock.removeListener('data', onData)

      const [line] = head.split('\r\n')
      const [method, target] = line.split(' ')
      if (auth) {
        const want = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
        const got = head
          .split('\r\n')
          .find((l) => l.toLowerCase().startsWith('proxy-authorization:'))
          ?.slice('proxy-authorization:'.length)
          .trim()
        if (got !== want) {
          log.push({ method, target, authed: false })
          sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
          return
        }
      }
      log.push({ method, target, authed: Boolean(auth) })

      const connectTo = (host, port, rewrite) => {
        const up = net.connect(port, host, () => {
          if (method === 'CONNECT') sock.write('HTTP/1.1 200 Connection established\r\n\r\n')
          else sock.write(rewrite)
          if (rest.length) up.write(rest)
          up.pipe(sock)
          sock.pipe(up)
        })
        up.on('error', () => sock.destroy())
      }

      if (method === 'CONNECT') {
        const at = target.lastIndexOf(':')
        connectTo(target.slice(0, at), Number(target.slice(at + 1)))
      } else {
        const u = new URL(target)
        const rewritten = line.replace(target, `${u.pathname}${u.search}`) + '\r\n' + head.split('\r\n').slice(1).join('\r\n') + '\r\n\r\n'
        connectTo(u.hostname, Number(u.port) || 80, rewritten)
      }
    }
    sock.on('data', onData)
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server, log }))
  })
}

const exe = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
if (!fs.existsSync(exe)) throw new Error(`Electron 未安装：${exe}`)

const origin = await startOrigin('FPB-E2E-ORIGIN')
const plainProxy = await startFakeProxy(null)
const authProxy = await startFakeProxy({ username: 'eu', password: 'ep' })

// 用独立的 userData 目录跑：否则每次 E2E 都往真实库里堆环境，
// 一旦超过分页阈值（默认每页 10 条），新建的环境落在第 2 页，
// 「等它出现在列表里」就会超时；而且真实用户的数据也会被测试污染。
const userDataDir = path.join(ROOT, '.e2e-userdata')
fs.rmSync(userDataDir, { recursive: true, force: true })
fs.mkdirSync(userDataDir, { recursive: true })

const app = spawn(
  exe,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
  { cwd: ROOT, stdio: 'ignore' }
)
let failed = null

try {
  await waitForDevTools(PORT)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const context = browser.contexts()[0]
  const page = context.pages().find((p) => p.url().includes('out/renderer')) ?? context.pages()[0]
  console.log('renderer url =', page.url())
  await page.waitForSelector('text=新建环境', { timeout: 15000 })

  // 1) 新建环境
  let name = `E2E 验证环境 ${Date.now()}`
  await page.click('button:has-text("新建环境")')
  await page.waitForSelector('input[placeholder*="店铺"]')
  await page.fill('input[placeholder*="店铺"]', name)
  // 启动 URL 指向假出口服务：内核打开后必须通过代理去访问它
  await page.fill('textarea', `http://127.0.0.1:${origin.port}/probe`)
  await page.click('button:has-text("创建")')
  // 列表是分页的（默认每页 10 条，按创建时间升序）：新建的环境在最后一页。
  // 用搜索框把它过滤出来，断言才与分页无关，同时顺带验证搜索功能。
  await page.fill('input[placeholder*="搜索环境"]', name)
  await page.waitForSelector(`text=${name}`, { timeout: 15000 })
  console.log('✓ 环境已创建')

  let row = page.locator('tr', { hasText: name })
  const summary = await row.locator('td').nth(3).innerText()
  console.log('  指纹摘要:', summary)

  // 2) 打开浏览器
  await row.locator('button:has-text("打开")').click()
  await row.locator('text=运行中').waitFor({ timeout: 45000 })
  console.log('✓ 内核已启动，状态=运行中')

  await page.screenshot({ path: SHOT })
  console.log('  截图:', SHOT)

  // 3) 停止
  await row.locator('button:has-text("停止")').click()
  await row.locator('text=未运行').waitFor({ timeout: 20000 })
  console.log('✓ 内核已停止')

  // 4) 换指纹（重新生成）
  // 断言看 seed，不看列表里的「指纹摘要」：摘要只有 4 个粗粒度字段
  // （Chrome major / 屏幕 / 时区 / CPU+内存），而重新生成会刻意保留 OS、locale、
  // 时区，内核 major 也由本机内核决定 —— 于是摘要的熵只剩「屏幕 × 硬件」这一项，
  // 两次抽到同一组合的概率有百分之几，用它断言会让 E2E 随机失败。
  // seed 是 randomBytes(12)，必然变化，且它才是「指纹真的换了」的根因。
  const seedBefore = await page.evaluate(async (n) => {
    const res = await window.api.profiles.list({ search: n })
    return res.items.find((p) => p.name === n)?.fingerprint?.seed ?? null
  }, name)
  if (!seedBefore) throw new Error('拿不到创建时的指纹 seed')

  await row.locator('button:has-text("换指纹")').click()
  await page.waitForTimeout(1200)
  const summary2 = await row.locator('td').nth(3).innerText()
  console.log('  换指纹后:', summary2)
  const seedAfter = await page.evaluate(async (n) => {
    const res = await window.api.profiles.list({ search: n })
    return res.items.find((p) => p.name === n)?.fingerprint?.seed ?? null
  }, name)
  if (!seedAfter) throw new Error('换指纹后读不到 seed')
  if (seedAfter === seedBefore) throw new Error(`换指纹未生成新 seed：${seedBefore}`)
  console.log(`✓ 指纹已重新生成（seed ${seedBefore.slice(0, 8)}… → ${seedAfter.slice(0, 8)}…）`)

  // 4.5) 环境详情 / 编辑页：改名、备注、分组、一致性体检、重新生成指纹
  const profileId = await page.evaluate(async (n) => {
    // 必须带 search：list({}) 只返回第一页，环境多了就找不到刚建的那个
    const res = await window.api.profiles.list({ search: n })
    return res.items.find((p) => p.name === n)?.id ?? null
  }, name)
  if (!profileId) throw new Error('拿不到刚创建环境的 id')
  // 分组要先建好：详情页的分组下拉是在挂载时拉取的
  const groupId = await page.evaluate(async () => {
    const g = await window.api.groups.create(`E2E 分组 ${Date.now()}`, null)
    return g.id
  })

  await row.locator('button:has-text("详情")').click()
  await page.waitForSelector('input[aria-label="环境名称"]', { timeout: 5000 })
  // 详情是环境管理的子视图：列表工具条必须消失
  await page.waitForSelector('button:has-text("新建环境")', { state: 'hidden', timeout: 5000 })
  const detailTitle = await page.locator('main h2').innerText()
  if (!detailTitle.includes(name)) throw new Error(`详情页标题不是当前环境：${detailTitle}`)
  const fpBefore = await page.locator('[aria-label="指纹摘要"]').innerText()
  if (!fpBefore.includes('User-Agent') || !fpBefore.includes('WebGL')) {
    throw new Error(`详情页没有显示指纹摘要：${fpBefore}`)
  }
  console.log('✓ 环境详情页打开，指纹摘要可见')

  // 一致性体检：刚生成的指纹不能有 error 级矛盾
  await page.click('button[aria-label="一致性体检"]')
  await page.waitForSelector('[aria-label="一致性得分"]', { timeout: 10000 })
  const scoreText = await page.locator('[aria-label="一致性得分"]').innerText()
  const score = Number(scoreText.replace(/\D+/g, ''))
  const errorIssues = await page.locator('[data-issue-level="error"]').count()
  if (errorIssues > 0) throw new Error(`体检出现 ${errorIssues} 个 error 级问题：${scoreText}`)
  if (!(score >= 90)) throw new Error(`体检得分过低：${scoreText}`)
  console.log(`✓ 一致性体检：${scoreText}，error 0 个`)
  await page.screenshot({ path: '/tmp/fpb-detail-check.png' })

  // 改名 / 备注 / 分组
  const renamed = `${name} 已改名`
  await page.fill('input[aria-label="环境名称"]', renamed)
  await page.fill('textarea[aria-label="环境备注"]', 'E2E 详情页写入的备注')
  await page.selectOption('select[aria-label="环境分组"]', groupId)
  await page.click('button[aria-label="保存环境信息"]')
  await page.locator('text=已保存').waitFor({ timeout: 10000 })
  const persisted = await page.evaluate(async (id) => {
    const p = await window.api.profiles.get(id)
    return { name: p?.name, note: p?.note, groupId: p?.groupId }
  }, profileId)
  if (persisted.name !== renamed) throw new Error(`改名未落库：${JSON.stringify(persisted)}`)
  if (persisted.note !== 'E2E 详情页写入的备注') throw new Error(`备注未落库：${JSON.stringify(persisted)}`)
  if (persisted.groupId !== groupId) throw new Error(`分组未落库：${JSON.stringify(persisted)}`)
  console.log('✓ 改名 / 备注 / 分组已落库')

  // 返回列表：新名字与新备注必须出现在列表行里
  await page.click('button[aria-label="返回环境列表"]')
  await page.waitForSelector('button:has-text("新建环境")', { timeout: 5000 })
  name = renamed
  row = page.locator('tr', { hasText: name })
  await row.waitFor({ timeout: 10000 })
  const nameCell = await row.locator('td').nth(1).innerText()
  if (!nameCell.includes('E2E 详情页写入的备注')) throw new Error(`列表未显示新备注：${nameCell}`)
  console.log('✓ 列表显示改名与备注')

  // 详情页换指纹：摘要必须变化，且旧体检结果要作废
  await row.locator('button:has-text("详情")').click()
  await page.waitForSelector('input[aria-label="环境名称"]', { timeout: 5000 })
  const nameValue = await page.inputValue('input[aria-label="环境名称"]')
  if (nameValue !== name) throw new Error(`详情页未回填已保存的名称：${nameValue}`)
  const groupValue = await page.inputValue('select[aria-label="环境分组"]')
  if (groupValue !== groupId) throw new Error(`详情页未回填已保存的分组：${groupValue}`)
  const beforeRegen = await page.locator('[aria-label="指纹摘要"]').innerText()
  await page.click('button[aria-label="一致性体检"]')
  await page.waitForSelector('[aria-label="一致性得分"]', { timeout: 10000 })
  await page.click('button[aria-label="重新生成指纹"]')
  await page.waitForTimeout(1500)
  const afterRegen = await page.locator('[aria-label="指纹摘要"]').innerText()
  if (afterRegen === beforeRegen) throw new Error('详情页重新生成指纹没有改变摘要')
  if ((await page.locator('[aria-label="一致性得分"]').count()) !== 0) {
    throw new Error('换指纹后旧的一致性体检结果没有被作废')
  }
  console.log('✓ 详情页回填已保存值；重新生成指纹生效，旧体检结果已作废')
  await page.screenshot({ path: '/tmp/fpb-detail.png' })
  await page.click('button[aria-label="返回环境列表"]')
  await page.waitForSelector('button:has-text("新建环境")', { timeout: 5000 })

  // 5) 代理管理：新增 -> 检测 -> 绑定 -> 内核确实走代理
  await page.click('nav button:has-text("代理管理")')
  await page.waitForSelector('button:has-text("新增代理")', { timeout: 5000 })
  await page.waitForSelector('button:has-text("新建环境")', { state: 'hidden', timeout: 5000 })
  console.log('✓ 切换到「代理管理」')

  const proxyName = `E2E 代理 ${Date.now()}`
  await page.click('button:has-text("新增代理")')
  await page.waitForSelector('input[placeholder*="留空则用地址"]')
  await page.fill('input[placeholder*="留空则用地址"]', proxyName)
  await page.fill('input[placeholder*="例如 127.0.0.1"]', '127.0.0.1')
  await page.fill('input[type="number"]', String(plainProxy.port))
  await page.click('button:has-text("保存")')
  await page.locator(`tr:has-text("${proxyName}")`).waitFor({ timeout: 10000 })
  console.log('✓ 代理已创建')

  // 让「检测」打本地假出口服务，而不是外网 ip-api.com
  // 走 settings.set 而不是已移除的 app.setSetting：后者会把任意设置项（含 apiToken）
  // 明文读给渲染进程，且绕过写入校验。
  const checkUrl = `http://127.0.0.1:${origin.port}/probe`
  await page.evaluate(async (url) => {
    await window.api.settings.set('proxy.checkUrl', url)
  }, checkUrl)

  const proxyRow = page.locator('tr', { hasText: proxyName })
  await proxyRow.locator('button:has-text("检测")').click()
  await proxyRow.locator('text=可用').waitFor({ timeout: 20000 })
  // 按整行文本断言，不按下标：代理表有 11 列，加全选框后所有下标都会平移，
  // 写死 nth() 会让「列顺序调整」这种无害改动把测试打挂。
  const checkedCells = await proxyRow.innerText()
  if (!checkedCells.includes('203.0.113.77')) throw new Error(`检测结果未显示出口 IP：${checkedCells}`)
  console.log('✓ 代理检测通过，出口信息已回写：', checkedCells)
  await page.screenshot({ path: '/tmp/fpb-proxies.png' })

  // 绑定到刚创建的环境
  await proxyRow.locator('button:has-text("绑定")').click()
  await page.waitForSelector(`label:has-text("${name}")`)
  await page.click(`label:has-text("${name}") input[type="checkbox"]`)
  await page.click('button:has-text("应用")')
  // 对话框要等所有绑定写入完成才关闭，等它消失才算真正保存完
  await page.waitForSelector('button:has-text("应用")', { state: 'detached', timeout: 15000 })
  await proxyRow.locator('text=1 个').waitFor({ timeout: 10000 })
  console.log('✓ 代理已绑定到环境')

  // 回环境管理，代理列应显示该代理地址
  await page.click('nav button:has-text("环境管理")')
  await page.waitForSelector('button:has-text("新建环境")', { timeout: 5000 })
  const proxyCell = await row.locator('td').nth(4).innerText()
  if (!proxyCell.includes(`127.0.0.1:${plainProxy.port}`)) {
    throw new Error(`环境列表未显示绑定的代理：${proxyCell}`)
  }
  console.log('✓ 环境列表显示绑定代理：', proxyCell)

  // 打开内核：流量必须经过假代理（plainProxy.log 里有记录就是证据）
  const before = plainProxy.log.length
  await row.locator('button:has-text("打开")').click()
  await row.locator('text=运行中').waitFor({ timeout: 45000 })
  await page.waitForTimeout(4000)
  const hits = plainProxy.log.slice(before).filter((e) => e.target.includes(String(origin.port)))
  if (hits.length === 0) {
    throw new Error(`内核启动后假代理没有收到任何请求，--proxy-server 注入未生效。日志：${JSON.stringify(plainProxy.log)}`)
  }
  console.log(`✓ 内核流量确实经过代理（${hits.length} 次转发，方法=${hits[0].method}）`)

  await row.locator('button:has-text("停止")').click()
  await row.locator('text=未运行').waitFor({ timeout: 20000 })
  console.log('✓ 带代理的内核已停止')

  // 6) 带认证代理：Chrome 不支持代理认证，必须改走本机 relay
  const authName = `E2E 认证代理 ${Date.now()}`
  await page.click('nav button:has-text("代理管理")')
  await page.waitForSelector('button:has-text("新增代理")', { timeout: 5000 })
  await page.click('button:has-text("新增代理")')
  await page.waitForSelector('input[placeholder*="留空则用地址"]')
  await page.fill('input[placeholder*="留空则用地址"]', authName)
  await page.fill('input[placeholder*="例如 127.0.0.1"]', '127.0.0.1')
  await page.fill('input[type="number"]', String(authProxy.port))
  await page.fill('input[placeholder="可选"] >> nth=0', 'eu')
  await page.fill('input[type="password"]', 'ep')
  await page.click('button:has-text("保存")')
  const authRow = page.locator('tr', { hasText: authName })
  await authRow.waitFor({ timeout: 10000 })
  await authRow.locator('button:has-text("绑定")').click()
  await page.waitForSelector(`label:has-text("${name}")`)
  await page.click(`label:has-text("${name}") input[type="checkbox"]`)
  await page.click('button:has-text("应用")')
  await page.waitForSelector('button:has-text("应用")', { state: 'detached', timeout: 15000 })

  await page.click('nav button:has-text("环境管理")')
  await page.waitForSelector('button:has-text("新建环境")', { timeout: 5000 })
  const authBefore = authProxy.log.length
  await row.locator('button:has-text("打开")').click()
  await row.locator('text=运行中').waitFor({ timeout: 45000 })
  await page.waitForTimeout(4000)
  const authHits = authProxy.log.slice(authBefore).filter((e) => e.target.includes(String(origin.port)))
  if (authHits.length === 0) {
    throw new Error(`带认证代理时内核没有经过代理，本机 relay 未生效。日志：${JSON.stringify(authProxy.log)}`)
  }
  if (!authHits.every((e) => e.authed)) {
    throw new Error('relay 没有把凭据补上，代理侧认证失败')
  }
  console.log(`✓ 带认证代理经本机 relay 生效（${authHits.length} 次转发，均带凭据）`)

  await row.locator('button:has-text("停止")').click()
  await row.locator('text=未运行').waitFor({ timeout: 20000 })

  // 6.5) 指纹检测：环境未运行时也要能自动拉起内核采样，并与 profile 期望逐项比对
  await page.click('nav button:has-text("指纹检测")')
  await page.waitForSelector('button:has-text("开始检测")', { timeout: 5000 })
  await page.locator('header select').first().selectOption({ label: name })
  await page.click('button:has-text("开始检测")')
  await page.waitForSelector('text=采样', { timeout: 90000 })
  const detectSummary = await page.locator('div:has-text("项一致")').first().innerText()
  if (!detectSummary.includes('0 项不一致')) {
    throw new Error(`指纹检测存在不一致项：${detectSummary.replace(/\s+/g, ' ')}`)
  }
  console.log('✓ 指纹检测：真实内核采样与 profile 期望完全一致')
  await page.screenshot({ path: '/tmp/fpb-detect.png' })

  // 6.6) RPA：从示例创建流程 -> 保存 -> 列表可见 -> 静态校验通过
  await page.click('nav button:has-text("RPA")')
  await page.waitForSelector('button:has-text("从示例新建")', { timeout: 5000 })
  await page.click('button:has-text("从示例新建")')
  await page.waitForSelector('button:has-text("保存"), button:has-text("创建")', { timeout: 5000 })
  await page.locator('header button:has-text("保存"), header button:has-text("创建")').first().click()
  await page.waitForTimeout(1200)
  const flows = await page.evaluate(async () => await window.api.rpa.list())
  const sampleFlow = flows.find((f) => f.name.includes('副本'))
  if (!sampleFlow) throw new Error('RPA 示例流程未能保存')
  const validation = await page.evaluate(async (id) => {
    const flow = await window.api.rpa.get(id)
    return flow ? await window.api.rpa.validate(flow) : null
  }, sampleFlow.id)
  if (!validation || validation.errors > 0) {
    throw new Error(`示例流程校验未通过：${JSON.stringify(validation?.issues?.slice(0, 3))}`)
  }
  console.log(`✓ RPA：示例流程已保存（${sampleFlow.stepCount} 步），静态校验 ${validation.warns} 条提示、0 个错误`)
  await page.screenshot({ path: '/tmp/fpb-rpa.png' })
  await page.evaluate(async (ids) => {
    for (const id of ids) await window.api.rpa.remove(id)
  }, flows.filter((f) => f.name.includes('副本')).map((f) => f.id))

  // 6.7) 自动化 API：启停正常；配了 Token 后无凭据必须 401，带 Token 才 200
  const apiStarted = await page.evaluate(async () => {
    await window.api.settings.set('apiToken', 'e2e-token')
    return await window.api.api.start()
  })
  if (!apiStarted.baseUrl || !apiStarted.baseUrl.includes('127.0.0.1')) {
    throw new Error(`API 未监听本机地址：${apiStarted.baseUrl}`)
  }
  const anon = await fetch(`${apiStarted.baseUrl}/api/v1/user/list`).then((r) => r.json())
  const authed = await fetch(`${apiStarted.baseUrl}/api/v1/user/list?token=e2e-token`).then((r) => r.json())
  const health = await fetch(`${apiStarted.baseUrl}/health`).then((r) => r.json())
  if (anon.code === 0) throw new Error('配置了 Token 却仍然允许无凭据访问')
  if (authed.code !== 0) throw new Error(`带 Token 仍被拒绝：${JSON.stringify(authed)}`)
  if (health.code !== 0 || health.data?.app !== 'fingerprint-browser') throw new Error(`/health 返回异常：${JSON.stringify(health)}`)
  const apiStopped = await page.evaluate(async () => {
    const s = await window.api.api.stop()
    await window.api.settings.set('apiToken', '')
    return s
  })
  if (apiStopped.running) throw new Error('API 停止后仍显示运行中')
  console.log(`✓ 自动化 API 启停 + Token 鉴权正常（${apiStarted.baseUrl}）`)

  // 7) 删除环境：前面几个页面都切走了，先回到环境管理再操作列表
  await page.click('nav button:has-text("环境管理")')
  await page.waitForSelector('button:has-text("新建环境")', { timeout: 5000 })
  row = page.locator('tr', { hasText: name })
  await row.waitFor({ timeout: 10000 })
  page.once('dialog', async (dialog) => {
    await dialog.accept()
  })
  await row.locator('button:has-text("删除")').click()
  await page.waitForSelector(`text=${name}`, { state: 'detached', timeout: 15000 })
  console.log('✓ 环境已删除')
  // 详情页创建的测试分组也要清掉，别留在真实数据目录里
  await page.evaluate(async (gid) => {
    await window.api.groups.remove(gid)
  }, groupId)

  // 删除代理（绑定环境已删，应当可以直接删）
  await page.click('nav button:has-text("代理管理")')
  await page.waitForSelector('button:has-text("新增代理")', { timeout: 5000 })
  page.once('dialog', async (dialog) => {
    await dialog.accept()
  })
  await page.locator('tr', { hasText: proxyName }).locator('button:has-text("删除")').click()
  await page.waitForSelector(`tr:has-text("${proxyName}")`, { state: 'detached', timeout: 15000 })
  console.log('✓ 代理已删除')

  // 还原检测端点设置，别把测试值留在真实数据目录里
  await page.evaluate(async () => {
    await window.api.settings.set('proxy.checkUrl', '')
  })

  // 8) 侧边栏导航：每个页面都必须是真的功能页，占位页（「计划实现」）不允许再出现
  const NAV = [
    { label: '代理管理', marker: 'button:has-text("新增代理")' },
    { label: 'Cookie / 会话', marker: 'button:has-text("+ 导入 Cookie / 会话")' },
    { label: '指纹检测', marker: 'button:has-text("开始检测")' },
    { label: 'TLS / HTTP2', marker: 'button:has-text("观测 TLS / HTTP2")' },
    { label: '内核能力', marker: 'h2:text-is("内核能力与剩余风险")' },
    { label: '扩展管理', marker: 'button:has-text("安装解包扩展")' },
    { label: 'Passkey', marker: 'h2:text-is("Passkey / WebAuthn")' },
    { label: '账号保管', marker: 'h2:text-is("账号保管")' },
    { label: '关联隔离', marker: 'h2:text-is("关联隔离")' },
    { label: '环境健康', marker: 'h2:text-is("环境健康度")' },
    { label: '监控告警', marker: 'button:has-text("检测漂移")' },
    { label: '定时调度', marker: 'button:has-text("+ 新建定时任务")' },
    { label: '资源监控', marker: 'h2:text-is("资源监控")' },
    { label: '操作历史', marker: 'h2:text-is("操作历史")' },
    { label: '备份恢复', marker: 'button:has-text("+ 立即备份")' },
    { label: '回收站', marker: 'h2:text-is("回收站")' },
    { label: '自动化 API', marker: 'text=接口清单' },
    { label: 'RPA', marker: 'button:has-text("从示例新建")' },
    { label: '设置', marker: 'text=启用本机自动化 API' }
  ]
  for (const item of NAV) {
    await page.click(`nav button:has-text("${item.label}")`)
    // 已实现页面必须真正顶掉占位页：只有各自的专属控件才能证明切换到位
    await page.waitForSelector(item.marker, { timeout: 5000 })
    if ((await page.locator('text=计划实现').count()) > 0) {
      throw new Error(`「${item.label}」仍在显示占位页`)
    }
    // 环境页的工具条必须消失，否则说明视图没真的切换
    await page.waitForSelector('button:has-text("新建环境")', { state: 'hidden', timeout: 5000 })
    // 选中态必须跟着走：被点的按钮 aria-current=page，环境管理不再是 page
    const selfCurrent = await page.getAttribute(`nav button:has-text("${item.label}")`, 'aria-current')
    const profilesCurrent = await page.getAttribute('nav button:has-text("环境管理")', 'aria-current')
    if (selfCurrent !== 'page') throw new Error(`「${item.label}」未获得 aria-current`)
    if (profilesCurrent !== null) throw new Error('「环境管理」的 aria-current 未被清除')
    // 断言真实渲染样式而不是 class 名。按钮带 transition-colors，
    // 必须等过渡结束再读计算样式，否则拿到的是过渡起点的旧值。
    await page.waitForTimeout(300)
    const styles = await page.$$eval('nav button', (els) =>
      els.map((e) => ({
        text: e.textContent,
        bg: getComputedStyle(e).backgroundColor
      }))
    )
    const self = styles.find((s) => s.text.includes(item.label))
    const profiles = styles.find((s) => s.text.includes('环境管理'))
    if (!self || !profiles) throw new Error(`侧边栏找不到「${item.label}」或「环境管理」`)
    if (self.bg === 'rgba(0, 0, 0, 0)') throw new Error(`「${item.label}」没有背景高亮`)
    if (self.bg === profiles.bg) throw new Error(`「${item.label}」与环境管理高亮相同，选中态未切换`)
    if (profiles.bg !== 'rgba(0, 0, 0, 0)') throw new Error('环境管理仍保持选中高亮')
    if (item.label === '代理管理') await page.screenshot({ path: '/tmp/fpb-nav-proxies.png' })
    console.log(`✓ 切换到「${item.label}」`)
  }

  // 9) 回到环境管理，列表与工具条必须还在
  await page.click('nav button:has-text("环境管理")')
  await page.waitForSelector('button:has-text("新建环境")', { timeout: 5000 })
  await page.waitForSelector('table')
  const ariaCurrent = await page.getAttribute('nav button:has-text("环境管理")', 'aria-current')
  if (ariaCurrent !== 'page') throw new Error('环境管理按钮缺少 aria-current')
  console.log('✓ 返回环境管理，列表完好')

  await browser.close()
} catch (e) {
  failed = e
} finally {
  app.kill('SIGTERM')
  for (const s of [origin, plainProxy, authProxy]) {
    try {
      s.server.closeAllConnections?.()
      s.server.close()
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// 假代理上残留的 keep-alive 连接会吊住事件循环：脚本跑完必须主动退出，
// 否则 npm run / CI 会一直等下去，拿不到退出码。
if (failed) {
  console.error('✗ E2E 失败:', failed.message)
  process.exit(1)
}
console.log('\nE2E 全部通过')
process.exit(0)
