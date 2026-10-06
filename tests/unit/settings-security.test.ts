import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, ensureDir, dbFile } from '../../src/main/paths'
import { initDatabase, closeDatabase, getDb } from '../../src/main/db'
import { settingsView, SETTING_DEFS } from '../../src/main/settings/defs'
import { getSetting, setSetting, settingExists } from '../../src/main/db/repositories/settings'
import { encryptionStatus, hasPlaintextSecrets } from '../../src/main/lib/crypto'

/**
 * 机密存储与展示的回归测试。
 *
 * 这里防的是三类真实事故：
 *  1. 设置接口把 apiToken 明文读给渲染进程（渲染层一旦被 XSS，token 就泄露，
 *     而 token 等于「任意启动/关闭环境」的能力）；
 *  2. 前端把 secret 当普通输入框回显，用户截图/录屏时顺手带出去；
 *  3. 钥匙串不可用时静默写明文，用户以为已加密。
 */

let tmpDir = ''

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-secret-'))
  setDataDir(tmpDir)
  ensureDir(path.join(tmpDir, 'profiles'))
  initDatabase(dbFile())
})

afterAll(() => {
  closeDatabase()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('secret 类型设置不回显给渲染层', () => {
  it('settingsView 里所有 secret 项的 value 恒为空串', () => {
    setSetting('apiToken', 'super-secret-token-value')
    const view = settingsView().find((v) => v.key === 'apiToken')
    expect(view).toBeTruthy()
    expect(view?.type).toBe('secret')
    // 关键断言：真实值绝不能出现在返回给界面的一刻
    expect(view?.value).toBe('')
    expect(JSON.stringify(view)).not.toContain('super-secret-token-value')
  })

  it('已设置的 secret 用 secretSet 标记，未设置时为 false', () => {
    setSetting('apiToken', 'tok-abc')
    expect(settingsView().find((v) => v.key === 'apiToken')?.secretSet).toBe(true)

    // 用户主动清空后应回到「未设置」状态
    setSetting('apiToken', '')
    const v = settingsView().find((x) => x.key === 'apiToken')
    expect(v?.secretSet).toBe(false)
    expect(v?.isDefault).toBe(true)
  })

  it('主进程内部仍能读到真实 token（脱敏只发生在展示层）', () => {
    setSetting('apiToken', 'tok-real-999')
    expect(getSetting('apiToken', '')).toBe('tok-real-999')
    const v = settingsView().find((x) => x.key === 'apiToken')
    expect(v?.value).toBe('')
  })

  it('每个 secret 定义都必须被脱敏，不能漏加新字段', () => {
    // 这条是「防未来」的：以后有人新增 type:'secret' 却忘了走脱敏分支，这里会红。
    const secrets = SETTING_DEFS.filter((d) => d.type === 'secret')
    expect(secrets.length).toBeGreaterThan(0)
    for (const d of secrets) {
      setSetting(d.key, 'leak-canary')
      const v = settingsView().find((x) => x.key === d.key)
      expect(v?.value, `${d.key} 未脱敏`).toBe('')
      expect(v?.secretSet, `${d.key} 未标记已设置`).toBe(true)
      setSetting(d.key, '')
    }
  })

  it('非 secret 项照常回显真实值', () => {
    setSetting('apiPort', 53000)
    const v = settingsView().find((x) => x.key === 'apiPort')
    expect(v?.value).toBe(53000)
    expect(v?.secretSet).toBeUndefined()
  })
})

describe('settingExists 区分「从未配置」与「主动清空」', () => {
  it('主动写入空串后 settingExists 为 true，getSetting 为空', () => {
    setSetting('apiToken', '')
    expect(settingExists('apiToken')).toBe(true)
    expect(getSetting('apiToken', 'fallback')).toBe('')
  })

  it('从未写过的 key：settingExists 为 false，走安全默认值', () => {
    const key = 'definitely-not-a-real-setting-key'
    expect(settingExists(key)).toBe(false)
    expect(getSetting(key, 'default-value')).toBe('default-value')
  })
})

describe('明文机密必须可被检出', () => {
  it('proxies.password_enc 出现 plain: 前缀时 hasPlaintextSecrets 为 true', () => {
    const db = getDb()
    expect(hasPlaintextSecrets()).toBe(false)
    db.prepare(
      `INSERT INTO proxies (id, name, scheme, host, port, password_enc, created_at, updated_at)
       VALUES ('px1', 'p', 'http', '127.0.0.1', 8080, 'plain:hunter2', 1, 1)`
    ).run()
    expect(hasPlaintextSecrets()).toBe(true)
    const st = encryptionStatus()
    expect(st.plaintextStored).toBe(true)
    expect(st.message).toBeTruthy()
    db.prepare("DELETE FROM proxies WHERE id = 'px1'").run()
    expect(hasPlaintextSecrets()).toBe(false)
  })

  it('webauthn 私钥明文同样被检出', () => {
    const db = getDb()
    // M14 之后 webauthn_credentials 有指向 profiles 的外键 + ON DELETE CASCADE，
    // 插孤儿行会被拒绝 —— 这本身就是修复生效的证据，所以先建一个环境。
    db.prepare(
      "INSERT INTO profiles (id, name, user_data_dir, created_at, updated_at) VALUES ('p1', 't', 'profiles/p1/user-data', 1, 1)"
    ).run()
    db.prepare(
      `INSERT INTO webauthn_credentials
         (id, profile_id, rp_id, user_handle, credential_id, public_key, private_key, sign_count, aaguid, created_at)
       VALUES ('wc1', 'p1', 'example.com', 'u1', 'c1', 'pk', 'plain:private', 0, '00000000-0000-0000-0000-000000000000', 1)`
    ).run()
    expect(hasPlaintextSecrets()).toBe(true)
    // 级联删除：删环境必须连带清掉私钥，否则凭据会残留
    db.prepare("DELETE FROM profiles WHERE id = 'p1'").run()
    expect((db.prepare("SELECT COUNT(*) c FROM webauthn_credentials WHERE id = 'wc1'").get() as { c: number }).c).toBe(0)
  })

  it('encryptionStatus 始终给出 available 布尔与可读结论', () => {
    const st = encryptionStatus()
    expect(typeof st.available).toBe('boolean')
    expect(typeof st.plaintextStored).toBe('boolean')
    // 钥匙串不可用 或 存在明文 → 必须有提示语；两者都正常时可以为 null
    if (!st.available || st.plaintextStored) expect(st.message).toBeTruthy()
  })
})
