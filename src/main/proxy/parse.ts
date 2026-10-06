import net from 'node:net'
import type { ProxyInput, ProxyRecord } from '@shared/types'

/**
 * 代理输入的解析与校验。
 *
 * 单独成模块的原因：这部分是纯函数（不碰数据库、不碰 Electron），
 * 可以直接在 vitest 里覆盖；而 service 会连带加载 better-sqlite3，
 * 那个包是为 Electron 重编译的，普通 Node 环境加载不了。
 */

export const SCHEMES: ProxyRecord['scheme'][] = ['http', 'https', 'socks5', 'socks5h', 'socks4']
const HOST_RE = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/

export interface ValidatedProxyInput {
  name: string
  scheme: ProxyRecord['scheme']
  host: string
  port: number
  username: string | null
  password?: string | null
  groupId: string | null
}

/**
 * 把用户可能粘贴进来的各种写法收敛成裸 host（可选带上地址里写的端口）。
 * 存储用裸地址（IPv6 不带方括号），拼启动参数时再加括号。
 */
function normalizeHost(raw: string, scheme: string): { host: string; portFromHost: number | null } {
  let rest = String(raw ?? '').trim()
  if (!rest) throw new Error('代理地址不能为空')

  const withScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(rest)
  if (withScheme) {
    const found = withScheme[1].toLowerCase()
    if (found !== scheme) throw new Error(`地址里的协议「${found}」与所选协议「${scheme}」不一致`)
    rest = withScheme[2]
  }
  rest = rest.replace(/^\/+/, '')
  if (/\s/.test(rest)) throw new Error('代理地址不能包含空格')
  if (rest.includes('/')) throw new Error('代理地址不能包含路径')
  if (rest.includes('@')) throw new Error('账号密码请填在对应字段，不要写在地址里')

  const takePort = (portText: string): number => {
    const p = Number(portText)
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`地址里的端口不合法：${portText}`)
    return p
  }

  // [::1] / [::1]:1080
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end < 0) throw new Error('IPv6 地址缺少右方括号')
    const inner = rest.slice(1, end)
    if (!net.isIPv6(inner)) throw new Error(`方括号内不是合法 IPv6 地址：${inner}`)
    const tail = rest.slice(end + 1)
    if (tail === '') return { host: inner, portFromHost: null }
    if (!tail.startsWith(':')) throw new Error(`地址格式无法识别：${rest}`)
    return { host: inner, portFromHost: takePort(tail.slice(1)) }
  }

  if (net.isIP(rest)) return { host: rest, portFromHost: null }

  const parts = rest.split(':')
  if (parts.length === 1) {
    if (!HOST_RE.test(rest)) throw new Error(`代理地址不是合法域名或 IP：${rest}`)
    return { host: rest, portFromHost: null }
  }
  // host:port —— 用户经常把整条地址连端口一起粘进来，这里接受并取出来
  if (parts.length === 2) {
    const [host, portText] = parts
    if (!HOST_RE.test(host) && !net.isIP(host)) throw new Error(`代理地址不是合法域名或 IP：${host}`)
    return { host, portFromHost: takePort(portText) }
  }
  throw new Error('IPv6 地址请用方括号包裹')
}

export function validateProxyInput(
  input: (Partial<ProxyInput> & { password?: string | null }) | undefined | null
): ValidatedProxyInput {
  const scheme = input?.scheme
  if (!scheme || !SCHEMES.includes(scheme)) throw new Error('代理协议必须是 http / https / socks5 / socks5h / socks4')
  const { host, portFromHost } = normalizeHost(String(input?.host ?? ''), scheme)

  const hasPortField = input?.port !== undefined && input?.port !== null && String(input.port).trim() !== ''
  const port = hasPortField ? Number(input?.port) : (portFromHost ?? NaN)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数')
  // 两处都填了端口且不一致时不能猜，猜错就是连到别人的代理上
  if (hasPortField && portFromHost !== null && port !== portFromHost) {
    throw new Error(`端口字段（${port}）与地址里的端口（${portFromHost}）不一致`)
  }

  const rawUser = input?.username
  const username = rawUser == null || String(rawUser).trim() === '' ? null : String(rawUser).trim()
  if (username && /\s/.test(username)) throw new Error('代理账号不能包含空格')

  const name = input?.name?.trim() || `${scheme}://${host}:${port}`
  return {
    name,
    scheme,
    host,
    port,
    username,
    password: input?.password === undefined ? undefined : input.password,
    groupId: input?.groupId ?? null
  }
}

/** 支持 host:port、host:port:user:pass、scheme://user:pass@host:port 三种常见格式 */
export function parseProxyLine(line: string): ProxyInput & { password?: string | null } {
  let rest = line.trim()
  let scheme: ProxyRecord['scheme'] = 'http'
  let user: string | null = null
  let pass: string | null = null

  const withScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(rest)
  if (withScheme) {
    const found = withScheme[1].toLowerCase()
    if (!SCHEMES.includes(found as ProxyRecord['scheme'])) throw new Error(`不支持的协议「${found}」`)
    scheme = found as ProxyRecord['scheme']
    rest = withScheme[2]
    const at = rest.lastIndexOf('@')
    if (at >= 0) {
      const creds = rest.slice(0, at)
      rest = rest.slice(at + 1)
      const colon = creds.indexOf(':')
      user = colon >= 0 ? creds.slice(0, colon) : creds
      pass = colon >= 0 ? creds.slice(colon + 1) : ''
    }
  }

  let host: string
  let portStr: string
  let tail: string
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end < 0) throw new Error('IPv6 地址缺少右方括号')
    host = rest.slice(0, end + 1)
    const after = rest.slice(end + 1)
    if (!after.startsWith(':')) throw new Error('缺少端口')
    const parts = after.slice(1).split(':')
    portStr = parts[0]
    tail = parts.slice(1).join(':')
  } else {
    const parts = rest.split(':')
    if (parts.length < 2) throw new Error('缺少端口')
    if (parts.length > 4) throw new Error('字段过多，应为 host:port[:user[:pass]]')
    host = parts[0]
    portStr = parts[1]
    tail = parts.slice(2).join(':')
  }
  if (tail) {
    const t = tail.split(':')
    if (t[0]) user = t[0]
    if (t.length > 1) pass = t.slice(1).join(':')
  }
  return { scheme, host, port: Number(portStr), username: user, password: pass }
}
