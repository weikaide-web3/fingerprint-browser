import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setDataDir, ensureDir, dbFile } from '../../src/main/paths'
import { initDatabase, closeDatabase } from '../../src/main/db'
import { setSetting } from '../../src/main/db/repositories/settings'
import { checkTarget } from '../../src/main/services/proxies'

/**
 * 两条「静态检查就能防住」的回归：
 *
 * 1. 主进程里禁止 require 内部模块。electron-vite 把主进程打成单个 bundle，
 *    动态 require('../db') 会原样留在产物里，运行时按 out/main/ 解析必然失败，
 *    而失败又被 try/catch 吞掉 —— 结果是「明文机密告警」这类安全逻辑
 *    在打包版里永久静默失效，开发环境却一切正常。
 *    （better-sqlite3 / electron 等外部包仍然允许 require，那是刻意的懒加载。）
 *
 * 2. 出口探测目标必须支持 https 并正确推端口。之前只按 http 拼请求，
 *    配上 https 的探测点就直接失败，用户看到「检测失败」而不是「配置不支持」。
 */

const SRC = path.join(__dirname, '..', '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('主进程不得用 require 加载内部模块', () => {
  it('src 下不存在 require(相对路径) 的内部模块引用', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        const t = line.trim()
        // 注释里提到这个写法是说明问题，不是代码 —— 不能自触发
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
        // 只匹配 require 后接相对路径字符串字面量
        const m = /require\(\s*['"](\.[^'"]+)['"]\s*\)/.exec(line)
        if (m) offenders.push(`${path.relative(SRC, file)}:${i + 1} ${m[0]}`)
      })
    }
    expect(offenders, `打包后会静默失效的动态 require:\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('出口探测目标解析', () => {
  let tmpDir = ''
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-target-'))
    setDataDir(tmpDir)
    ensureDir(path.join(tmpDir, 'profiles'))
    initDatabase(dbFile())
  })
  afterAll(() => {
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('未配置时用默认目标', () => {
    setSetting('proxy.checkUrl', '')
    const t = checkTarget()
    expect(t.host).toBeTruthy()
  })

  it('https 探测点：tls=true 且默认端口 443', () => {
    setSetting('proxy.checkUrl', 'https://ipinfo.io/json')
    const t = checkTarget()
    expect(t.tls).toBe(true)
    expect(t.host).toBe('ipinfo.io')
    expect(t.port).toBe(443)
    expect(t.path).toBe('/json')
  })

  it('https 显式端口保留', () => {
    setSetting('proxy.checkUrl', 'https://example.com:8443/geo')
    const t = checkTarget()
    expect(t.tls).toBe(true)
    expect(t.port).toBe(8443)
  })

  it('http 探测点：tls=false 且默认端口 80', () => {
    setSetting('proxy.checkUrl', 'http://ip-api.com/json/?fields=status,country')
    const t = checkTarget()
    expect(t.tls).toBe(false)
    expect(t.port).toBe(80)
    // query 必须保留，否则探测点返回的字段会退化
    expect(t.path).toContain('?fields=')
  })

  it('非 http(s) 协议退回默认目标而不是抛错', () => {
    setSetting('proxy.checkUrl', 'ftp://example.com/')
    const t = checkTarget()
    expect(t.host).toBeTruthy()
    expect(t.tls).not.toBe(true)
  })

  it('垃圾配置退回默认目标', () => {
    setSetting('proxy.checkUrl', 'not a url')
    const t = checkTarget()
    expect(t.host).toBeTruthy()
  })
})
