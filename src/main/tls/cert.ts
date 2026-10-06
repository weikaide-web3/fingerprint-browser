import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { dataDir, ensureDir } from '../paths'
import { log, logError } from '../lib/log'

/**
 * 本地观测用的自签证书。
 *
 * 只在「本机 TLS 源服务器」这一条链路上用：内核带 --ignore-certificate-errors
 * 直连我们，才能在内核与源服务器之间看到明文 HTTP/2 帧。
 * 证书用 openssl 现生成（macOS 自带 LibreSSL），生成一次后缓存复用 ——
 * 每次重新生成会让内核的会话票据失效，观测到的形状反而不稳定。
 */

/**
 * 观测用的假主机名。
 *
 * 刻意不用 .local：macOS 的系统代理绕过列表默认包含 .local，
 * Chrome 会继承它并对 .local 走 mDNS 直连，于是观测代理被完全绕过、
 * 导航一直挂到超时。.test 是 RFC 6761 保留的永不解析域，
 * 走代理时由 tap 解析回 127.0.0.1，既稳定又不污染真实 DNS。
 */
export const PROBE_HOST = 'tls-probe.test'

export interface ProbeCert {
  key: string
  cert: string
  host: string
  /** 证书对应的 SPKI 摘要，可拼进 --ignore-certificate-errors-spki-list（比全局忽略更安全） */
  spkiList: string
}

function certDir(): string {
  return ensureDir(path.join(dataDir(), 'tls-probe'))
}

function openssl(args: string[]): string {
  return execFileSync('/usr/bin/openssl', args, { encoding: 'utf8' })
}

/**
 * 生成（或读取缓存的）自签证书。
 * 失败时返回 null：调用方据此退回「只做 tap 被动观测」，而不是让整个检测崩掉。
 */
export function probeCert(): ProbeCert | null {
  const dir = certDir()
  const keyPath = path.join(dir, 'probe-key.pem')
  const certPath = path.join(dir, 'probe-cert.pem')
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const key = fs.readFileSync(keyPath, 'utf8')
      const cert = fs.readFileSync(certPath, 'utf8')
      // 主机名换过（旧证书 CN 还是老名字）必须重签：
      // 否则内核的证书校验会失败，而表现为「导航超时」这种查不出来的症状
      if (certCovers(cert, PROBE_HOST)) return { key, cert, host: PROBE_HOST, spkiList: spkiOf(cert) }
      log('tls-probe', `缓存证书的 CN 不覆盖 ${PROBE_HOST}，重新签发`)
    }
    // -nodes：不加密私钥；本机文件权限已限定在用户目录
    const out = openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '3650',
      '-nodes',
      '-subj',
      `/CN=${PROBE_HOST}`,
      '-addext',
      `subjectAltName=DNS:${PROBE_HOST},DNS:localhost,IP:127.0.0.1`
    ])
    if (!fs.existsSync(certPath)) throw new Error(out || 'openssl 未产出证书')
    const key = fs.readFileSync(keyPath, 'utf8')
    const cert = fs.readFileSync(certPath, 'utf8')
    log('tls-probe', `已生成观测用自签证书（CN=${PROBE_HOST}）`)
    return { key, cert, host: PROBE_HOST, spkiList: spkiOf(cert) }
  } catch (e) {
    logError('tls-probe', '生成自签证书失败，HTTP/2 观测将不可用', e)
    return null
  }
}

/** 证书公钥的 base64(SHA256(SPKI))：Chrome 用它做 --ignore-certificate-errors-spki-list */
function spkiOf(pem: string): string {
  try {
    const cert = new crypto.X509Certificate(pem)
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' })
    return crypto.createHash('sha256').update(spki).digest('base64')
  } catch (e) {
    logError('tls-probe', '计算证书 SPKI 失败', e)
    return ''
  }
}

/** 证书的 SAN（退化到 CN）是否覆盖目标主机 */
function certCovers(pem: string, host: string): boolean {
  try {
    const cert = new crypto.X509Certificate(pem)
    const san = cert.subjectAltName ?? ''
    if (san.split(',').some((p) => p.trim().replace(/^DNS:/i, '') === host)) return true
    return new RegExp(`CN=(?:[^,]*\\b)?${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(cert.subject)
  } catch {
    return false
  }
}
