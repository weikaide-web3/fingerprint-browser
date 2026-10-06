import { describe, it, expect } from 'vitest'
import {
  decideRetention,
  matchesKey,
  normalizeRetention,
  partitionCookies,
  partitionLocalStorage,
  presetKeys,
  KEY_PRESETS
} from '../../src/main/session/retention'
import { DEFAULT_RETENTION, type CookieRecord } from '@shared/session'

/**
 * 登录态保留策略单测。
 * 这里测的是「会不会误删关键 cookie」——删错一条，账号在服务端就变新设备，
 * 所以断言重点放在：受保护键必须一条不少地活下来，且普通统计 cookie 仍被清掉。
 */

const cookie = (name: string, domain = '.google.com'): CookieRecord => ({
  name,
  value: 'v-' + name,
  domain,
  path: '/',
  expires: 1_800_000_000,
  httpOnly: false,
  secure: true,
  sameSite: 'Lax'
})

const DAY = 86_400_000

describe('关键键匹配', () => {
  it('精确匹配大小写不敏感', () => {
    expect(matchesKey('__Secure-1PSID', ['__secure-1psid'])).toBe(true)
    expect(matchesKey('__SECURE-1PSID', ['__Secure-1PSID'])).toBe(true)
  })

  it('通配只按 * 展开，其它字符不当正则元字符', () => {
    expect(matchesKey('com.x.foo', ['com.x.*'])).toBe(true)
    // 'a.c' 不该匹配 'abc'：点必须按字面量处理
    expect(matchesKey('abc', ['a.c'])).toBe(false)
    expect(matchesKey('a.c', ['a.c'])).toBe(true)
  })

  it('空模式与空白模式都不匹配任何东西', () => {
    expect(matchesKey('sid', [])).toBe(false)
    expect(matchesKey('sid', ['', '   '])).toBe(false)
  })
})

describe('清理时的分区', () => {
  it('受保护键保留，其余全部清理', () => {
    const all = [cookie('__Secure-1PSID'), cookie('SID'), cookie('_ga'), cookie('NID')]
    const { keep, remove } = partitionCookies(all, ['sid', '__secure-1psid', 'nid'])
    expect(keep.map((c) => c.name)).toEqual(['__Secure-1PSID', 'SID', 'NID'])
    expect(remove.map((c) => c.name)).toEqual(['_ga'])
  })

  it('没有保护键时全清（保持旧行为）', () => {
    const all = [cookie('SID'), cookie('_ga')]
    const { keep, remove } = partitionCookies(all, [])
    expect(keep).toEqual([])
    expect(remove).toHaveLength(2)
  })

  it('localStorage 同样按键名保护', () => {
    const items = [
      { name: 'gt', value: 'x' },
      { name: 'g_state', value: '{}' },
      { name: 'last-search', value: 'q' }
    ]
    const { keep, remove } = partitionLocalStorage(items, ['gt', 'g_state'])
    expect(keep.map((i) => i.name)).toEqual(['gt', 'g_state'])
    expect(remove.map((i) => i.name)).toEqual(['last-search'])
  })
})

describe('策略归一化', () => {
  it('非法 onExpire 退回默认，避免脏数据让清理逻辑崩掉', () => {
    expect(normalizeRetention({ onExpire: 'wipe_everything' as never }).onExpire).toBe(DEFAULT_RETENTION.onExpire)
    expect(normalizeRetention(null).onExpire).toBe('keep')
  })

  it('maxAgeDays 取整、负数归零、null 表示永不清理', () => {
    expect(normalizeRetention({ maxAgeDays: 30.7 }).maxAgeDays).toBe(30)
    expect(normalizeRetention({ maxAgeDays: -5 }).maxAgeDays).toBe(0)
    expect(normalizeRetention({ maxAgeDays: null }).maxAgeDays).toBeNull()
    expect(normalizeRetention({ maxAgeDays: 'abc' as never }).maxAgeDays).toBeNull()
  })

  it('保护键去重去空白', () => {
    expect(normalizeRetention({ protectedKeys: ['sid', ' sid ', '', 'twid'] }).protectedKeys).toEqual(['sid', 'twid'])
  })
})

describe('到期判定', () => {
  const created = Date.UTC(2026, 0, 1)

  it('maxAgeDays=null 时永不过期', () => {
    const d = decideRetention(DEFAULT_RETENTION, created + 400 * DAY, created, created + 400 * DAY)
    expect(d.expired).toBe(false)
    expect(d.action).toBe('keep')
    expect(d.daysLeft).toBeNull()
  })

  it('年龄以最后打开时间为基准，而不是创建时间', () => {
    const r = { ...DEFAULT_RETENTION, maxAgeDays: 30, onExpire: 'clear_cookies' as const }
    // 创建很久但一直在用 => 不该过期
    const active = decideRetention(r, created + 395 * DAY, created, created + 400 * DAY)
    expect(active.ageDays).toBe(5)
    expect(active.expired).toBe(false)
    expect(active.daysLeft).toBe(25)
    // 从没打开过 => 按创建时间算，已过期
    const idle = decideRetention(r, null, created, created + 400 * DAY)
    expect(idle.expired).toBe(true)
    expect(idle.action).toBe('clear_cookies')
  })

  it('onExpire=keep 时到期只提醒不动数据', () => {
    const r = { ...DEFAULT_RETENTION, maxAgeDays: 10, onExpire: 'keep' as const }
    const d = decideRetention(r, created, created + 11 * DAY, created + 11 * DAY)
    expect(d.expired).toBe(true)
    expect(d.action).toBe('keep')
  })

  it('到期当天就算过期（daysLeft<=0）', () => {
    const r = { ...DEFAULT_RETENTION, maxAgeDays: 10, onExpire: 'clear_all' as const }
    const d = decideRetention(r, created, created, created + 10 * DAY)
    expect(d.daysLeft).toBe(0)
    expect(d.expired).toBe(true)
    expect(d.action).toBe('clear_all')
  })
})

describe('内置关键键预设', () => {
  it('Google 预设覆盖登录态本体与轮换标记', () => {
    const keys = presetKeys(['google'])
    for (const k of ['sid', '__secure-1psid', '__secure-1psidts', 'sapisid']) {
      expect(keys, `缺少 ${k}`).toContain(k)
    }
  })

  it('X 预设覆盖 twid/ct0 与设备锚点', () => {
    const keys = presetKeys(['x'])
    for (const k of ['twid', 'ct0', '__cuid', 'gt']) {
      expect(keys, `缺少 ${k}`).toContain(k)
    }
  })

  it('预设合并后去重，未选中的站点不会被带进来', () => {
    const keys = presetKeys(['google', 'x'])
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain('cf_clearance')
  })

  it('每个预设都能实际应用：示例 cookie 至少命中一条', () => {
    const sample: Record<string, string[]> = {
      google: ['SID', '__Secure-1PSIDTS', 'NID'],
      x: ['twid', 'ct0', '__cuid'],
      cloudflare: ['__cf_bm', 'cf_clearance'],
      common: ['lang', 'csrf_token']
    }
    for (const preset of KEY_PRESETS) {
      const keys = presetKeys([preset.id])
      for (const name of sample[preset.id]) {
        expect(matchesKey(name, keys), `${preset.id} 应保护 ${name}`).toBe(true)
      }
    }
  })
})