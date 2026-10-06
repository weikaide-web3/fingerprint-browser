import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, profileUserDataDir, ensureDir } from '../../src/main/paths'
import { initDatabase, closeDatabase } from '../../src/main/db'
import { createProfile } from '../../src/main/db/repositories/profiles'
import { generateFingerprint } from '../../src/main/fingerprint/generator'
import { resolveChromiumExecutable, detectKernelVersion } from '../../src/main/browser/executable'
import { launchProfile, stopProfile, stopAllProfiles } from '../../src/main/browser/launcher'
import { getSession } from '../../src/main/browser/registry'
import { attachedState, enroll, issues, list, status, verify } from '../../src/main/services/webauthn'
import type { Profile } from '@shared/types'

/**
 * P1-5 验收：passkey 必须在真实内核里注册、持久化，并在环境重启后仍能登录。
 *
 * 为什么这条链路必须实测：CDP 的虚拟认证器没有 aaguid 参数（内核随机生成），
 * 而 getCredentials 会回传私钥 —— 只有把 credentialId + 私钥存下来重新注入，
 * 同一个环境下次打开才会被认成「还是那把 passkey」，而不是降级到手机验证。
 */

let tmpDir = ''
let server: http.Server
let port = 0
let profile: Profile

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>passkey</title></head>
<body><h1>passkey 测试页</h1></body></html>`

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-wa-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  initDatabase(path.join(tmpDir, 'app.db'))

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => resolve())
  })
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await stopAllProfiles().catch(() => undefined)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  closeDatabase()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const origin = (): string => `http://localhost:${port}/`

async function launch(p: Profile): Promise<void> {
  await launchProfile({ profile: p, headless: true })
}

describe('Passkey / WebAuthn（真实内核 + 虚拟认证器）', () => {
  it('注册 → 持久化 → 重启后仍能用同一把凭证断言', async () => {
    const exe = resolveChromiumExecutable()
    profile = createProfile({
      name: 'passkey-live',
      fingerprint: generateFingerprint({
        seed: 'webauthn-live-seed',
        os: 'macOS',
        locale: 'en-US',
        timezone: 'Asia/Shanghai',
        kernelVersion: detectKernelVersion(exe) ?? '132.0.6834.110'
      })
    })

    await launch(profile)
    expect(getSession(profile.id)).toBeTruthy()

    // 启动时 launcher 已挂载认证器
    const st = status(profile.id)
    expect(st.attached, '虚拟认证器未挂载').toBe(true)
    expect(st.configured?.enabled).toBe(true)

    const created = await enroll(profile.id, {
      rpId: 'localhost',
      rpName: 'FPB 测试',
      userName: 'tester@example.com',
      origin: origin()
    })
    expect(created.message).toContain('注册成功')
    expect(created.rpId).toBe('localhost')
    expect(created.credentialId).toBeTruthy()

    const creds = list(profile.id)
    expect(creds).toHaveLength(1)
    // 私钥必须落库：否则重启后无法继续签名，passkey 等于作废。
    // 界面视图只暴露 hasPrivateKey 布尔量，私钥本身不得离开主进程。
    expect(creds[0].hasPrivateKey).toBe(true)
    expect('privateKey' in creds[0]).toBe(false)
    expect(creds[0].credentialId).toBe(created.credentialId)
    expect(creds[0].publicKey).toBeTruthy()

    const first = await verify(profile.id, created.credentialId, origin())
    expect(first.ok, first.message).toBe(true)
    // signCount 必须是真实读到的数字（不是 '?'）：读不到说明 authData 解析失败，
    // 那意味着标志位体检也全部失效，passkey 的「设备一致性」就没人把关了
    expect(typeof first.signCount, first.message).toBe('number')
    expect(first.signCount).toBeGreaterThanOrEqual(1)
    expect(first.message).toContain('断言成功')

    // 重启：认证器实例消失，必须靠库里的 credentialId + 私钥重新注入
    await stopProfile(profile.id)
    await launch(profile)
    const after = attachedState(profile.id)
    expect(after, '重启后未重新挂载认证器').toBeTruthy()
    expect(after!.injected).toBe(1)
    expect(after!.failed, JSON.stringify(after!.failed)).toHaveLength(0)

    const second = await verify(profile.id, created.credentialId, origin())
    expect(second.ok, second.message).toBe(true)
    // signCount 必须递增，否则站点会认为凭证被复制
    expect(second.signCount).toBeGreaterThan(first.signCount ?? 0)

    // 体检必须指出 AAGUID 与 profile 声明不一致（CDP 无法指定，实测结论）
    const found = issues(profile.id)
    expect(found.some((i) => i.includes('AAGUID'))).toBe(true)

    await stopProfile(profile.id)
  }, 180000)

  it('未运行环境也能注册：服务会自行拉起环境', async () => {
    const p = createProfile({
      name: 'passkey-autostart',
      fingerprint: generateFingerprint({ seed: 'webauthn-autostart', os: 'Windows', locale: 'en-US', timezone: 'America/New_York' })
    })
    expect(getSession(p.id)).toBeFalsy()
    const r = await enroll(p.id, { rpId: 'localhost', origin: origin() })
    expect(r.message).toContain('注册成功')
    // Windows profile 应声明 Windows Hello 的 AAGUID
    expect(p.fingerprint?.webauthn.model).toBeTruthy()
    await stopProfile(p.id)
  }, 180000)

  it('rpId 与页面域名不匹配时直接拒绝，而不是让内核报模糊错误', async () => {
    const p = createProfile({ name: 'passkey-bad-rp', fingerprint: generateFingerprint({ seed: 'wa-bad-rp' }) })
    await expect(enroll(p.id, { rpId: 'accounts.google.com', origin: origin() })).rejects.toThrow(/与页面域名 .* 不匹配/)
    expect(getSession(p.id)).toBeFalsy()
  })

  it('profileUserDataDir 与 profile 一致（passkey 不会写到别的目录）', () => {
    expect(profileUserDataDir('x')).toContain('x')
  })
})