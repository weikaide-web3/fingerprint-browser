import { describe, it, expect } from 'vitest'
import { parseCron, isValidCron, nextRun, describeCron } from '../../src/shared/cron'

describe('cron 解析', () => {
  it('星号展开为完整范围', () => {
    const f = parseCron('* * * * *')
    expect(f.minute.length).toBe(60)
    expect(f.hour.length).toBe(24)
    expect(f.dayOfMonth.length).toBe(31)
    expect(f.month.length).toBe(12)
    expect(f.dayOfWeek.length).toBe(7)
  })

  it('固定数字', () => {
    const f = parseCron('30 9 * * *')
    expect(f.minute).toEqual([30])
    expect(f.hour).toEqual([9])
  })

  it('列表 a,b,c', () => {
    const f = parseCron('0,15,30,45 * * * *')
    expect(f.minute).toEqual([0, 15, 30, 45])
  })

  it('范围 a-b', () => {
    const f = parseCron('0 * 1-5 * *')
    expect(f.dayOfMonth).toEqual([1, 2, 3, 4, 5])
  })

  it('步长 */n 与 a-b/n', () => {
    expect(parseCron('*/15 * * * *').minute).toEqual([0, 15, 30, 45])
    expect(parseCron('0 9-17/4 * * *').hour).toEqual([9, 13, 17])
  })

  it('周日 7 归一为 0', () => {
    const f = parseCron('0 0 * * 7')
    expect(f.dayOfWeek).toEqual([0])
  })

  it('非法表达式被拒', () => {
    expect(isValidCron('* * * *')).toBe(false) // 只有 4 字段
    expect(isValidCron('60 * * * *')).toBe(false) // 分钟越界
    expect(isValidCron('* 24 * * *')).toBe(false) // 小时越界
    expect(isValidCron('*/0 * * * *')).toBe(false) // 步长 0
    expect(isValidCron('a * * * *')).toBe(false)
    expect(isValidCron('5-2 * * * *')).toBe(false) // lo>hi
  })

  it('合法表达式通过', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('*/30 * * * *')).toBe(true)
    expect(isValidCron('0 9 * * 1')).toBe(true)
  })
})

describe('cron nextRun', () => {
  it('每天 9:00：从 8:00 出发得到当天 9:00', () => {
    const from = new Date(2026, 0, 15, 8, 0, 0).getTime()
    const next = nextRun('0 9 * * *', from)
    expect(next).not.toBeNull()
    const d = new Date(next as number)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(15)
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(0)
  })

  it('已过今天 9:00：跳到次日 9:00', () => {
    const from = new Date(2026, 0, 15, 10, 30, 0).getTime()
    const next = new Date(nextRun('0 9 * * *', from) as number)
    expect(next.getDate()).toBe(16)
    expect(next.getHours()).toBe(9)
  })

  it('每 15 分钟：严格大于当前分钟', () => {
    const from = new Date(2026, 5, 1, 12, 7, 30).getTime()
    const next = new Date(nextRun('*/15 * * * *', from) as number)
    expect(next.getMinutes()).toBe(15)
    expect(next.getSeconds()).toBe(0)
  })

  it('每周一 9:00', () => {
    // 2026-01-15 是周四
    const from = new Date(2026, 0, 15, 0, 0, 0).getTime()
    const next = new Date(nextRun('0 9 * * 1', from) as number)
    expect(next.getDay()).toBe(1) // 周一
    expect(next.getDate()).toBe(19) // 下一个周一
    expect(next.getHours()).toBe(9)
  })

  it('不可能的日期（2 月 30）返回 null', () => {
    const from = new Date(2026, 0, 1).getTime()
    expect(nextRun('0 0 30 2 *', from)).toBeNull()
  })
})

describe('describeCron', () => {
  it('非法表达式给出提示', () => {
    expect(describeCron('bad')).toBe('无效的 cron')
  })
  it('合法表达式返回描述', () => {
    expect(describeCron('0 9 * * *')).toContain('时=9')
  })
})
