import { describe, it, expect } from 'vitest'
import { planTick } from '../../src/main/services/scheduler'
import { decideDrift } from '../../src/main/services/monitor'
import { isOrphanChromiumCommand, parsePsLine } from '../../src/main/browser/crash-recovery'

describe('调度器 planTick（纯决策）', () => {
  const AT = 1_000_000

  it('未启用的任务既不触发也不补算', () => {
    const r = planTick([{ id: 'a', enabled: false, cron: '* * * * *', nextRunAt: 0 }], AT)
    expect(r.fire).toEqual([])
    expect(r.backfill).toEqual([])
  })

  it('nextRunAt 为空时进入 backfill 并补算下次时间', () => {
    const r = planTick([{ id: 'a', enabled: true, cron: '0 * * * *', nextRunAt: null }], AT)
    expect(r.fire).toEqual([])
    expect(r.backfill).toHaveLength(1)
    expect(r.backfill[0].id).toBe('a')
    expect(r.backfill[0].nextRunAt).not.toBeNull()
    expect(r.backfill[0].nextRunAt as number).toBeGreaterThan(AT)
  })

  it('到期任务进入 fire 并推进下次时间', () => {
    const r = planTick([{ id: 'a', enabled: true, cron: '* * * * *', nextRunAt: AT - 1 }], AT)
    expect(r.fire).toHaveLength(1)
    expect(r.fire[0].id).toBe('a')
    expect(r.fire[0].nextRunAt as number).toBeGreaterThan(AT)
  })

  it('未到期的任务不触发', () => {
    const r = planTick([{ id: 'a', enabled: true, cron: '* * * * *', nextRunAt: AT + 100000 }], AT)
    expect(r.fire).toEqual([])
    expect(r.backfill).toEqual([])
  })

  it('nextRunAt 恰好等于 at 视为到期', () => {
    const r = planTick([{ id: 'a', enabled: true, cron: '* * * * *', nextRunAt: AT }], AT)
    expect(r.fire).toHaveLength(1)
  })

  it('混合场景：到期/未到期/未启用/待补算各归其位', () => {
    const r = planTick(
      [
        { id: 'due', enabled: true, cron: '* * * * *', nextRunAt: AT - 5 },
        { id: 'future', enabled: true, cron: '* * * * *', nextRunAt: AT + 999999 },
        { id: 'off', enabled: false, cron: '* * * * *', nextRunAt: 0 },
        { id: 'new', enabled: true, cron: '0 * * * *', nextRunAt: null }
      ],
      AT
    )
    expect(r.fire.map((x) => x.id)).toEqual(['due'])
    expect(r.backfill.map((x) => x.id)).toEqual(['new'])
  })
})

describe('监控 decideDrift（漂移判定）', () => {
  it('分数下降达到阈值触发告警并保留旧基线', () => {
    const r = decideDrift(90, 70, 15)
    expect(r.drop).toBe(20)
    expect(r.alert).toBe(true)
    expect(r.updateBaseline).toBe(false)
  })

  it('下降未达阈值则更新基线且不告警', () => {
    const r = decideDrift(90, 80, 15)
    expect(r.drop).toBe(10)
    expect(r.alert).toBe(false)
    expect(r.updateBaseline).toBe(true)
  })

  it('分数上升：drop 为负，更新基线', () => {
    const r = decideDrift(80, 95, 15)
    expect(r.drop).toBe(-15)
    expect(r.alert).toBe(false)
    expect(r.updateBaseline).toBe(true)
  })

  it('恰好等于阈值视为告警（>=）', () => {
    const r = decideDrift(90, 75, 15)
    expect(r.drop).toBe(15)
    expect(r.alert).toBe(true)
    expect(r.updateBaseline).toBe(false)
  })

  it('默认阈值 15', () => {
    expect(decideDrift(90, 76).alert).toBe(false)
    expect(decideDrift(90, 75).alert).toBe(true)
  })
})

describe('崩溃恢复纯函数', () => {
  const ROOT = '/Users/me/Library/Application Support/FingerprintBrowser/profiles'

  it('parsePsLine 解析 pid + 命令', () => {
    const r = parsePsLine('  1234 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=x')
    expect(r).not.toBeNull()
    expect(r?.pid).toBe(1234)
    expect(r?.cmd).toContain('--user-data-dir=x')
  })

  it('parsePsLine 空行 / 无空格 / 非数字 pid 返回 null', () => {
    expect(parsePsLine('')).toBeNull()
    expect(parsePsLine('   ')).toBeNull()
    expect(parsePsLine('12345')).toBeNull()
    expect(parsePsLine('abc /bin/x')).toBeNull()
  })

  it('isOrphanChromiumCommand 命中本 app 的浏览器进程', () => {
    const cmd = `/Chromium --user-data-dir=${ROOT}/prof1`
    expect(isOrphanChromiumCommand(cmd, ROOT, 100, 200)).toBe(true)
  })

  it('绝不误杀用户自己的 Chrome（命令行不含本 app root）', () => {
    const cmd = '/Google Chrome --user-data-dir=/Users/me/Google/Chrome/Default'
    expect(isOrphanChromiumCommand(cmd, ROOT, 100, 200)).toBe(false)
  })

  it('不含 --user-data-dir 的进程不匹配', () => {
    const cmd = `/some-helper ${ROOT}/x`
    expect(isOrphanChromiumCommand(cmd, ROOT, 100, 200)).toBe(false)
  })

  it('self pid 与 0 pid 永不被杀', () => {
    const cmd = `/Chromium --user-data-dir=${ROOT}/prof1`
    expect(isOrphanChromiumCommand(cmd, ROOT, 100, 100)).toBe(false)
    expect(isOrphanChromiumCommand(cmd, ROOT, 100, 0)).toBe(false)
  })
})
