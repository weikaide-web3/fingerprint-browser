import { describe, it, expect } from 'vitest'
import { evalCondition, interpolate } from '../../src/main/rpa/expr'
import type { Value } from '../../src/main/rpa/expr'

/**
 * 条件求值器单测。
 * 这套东西是 RPA 的 if / loop 唯一入口，所以既要测「能算对」，
 * 也要测「写错了要报错而不是静默当成 true」—— 后者会让流程悄悄跑偏。
 */

const vars: Record<string, Value> = {
  logged_in: true,
  username: 'alice',
  count: 3,
  countStr: '3',
  emptyText: '',
  nothing: null,
  'a.b': 'dotted'
}

const yes = (src: string): boolean => {
  const r = evalCondition(src, vars)
  expect(r.error, `条件不应报错：${src}`).toBeNull()
  return r.value
}

describe('RPA 条件求值', () => {
  it('空条件视为真（没写条件就等于无条件执行）', () => {
    expect(evalCondition('', vars)).toEqual({ value: true, error: null })
    expect(evalCondition('   ', vars)).toEqual({ value: true, error: null })
  })

  it('布尔变量与取反', () => {
    expect(yes('$logged_in')).toBe(true)
    expect(yes('not $logged_in')).toBe(false)
    expect(yes('!$logged_in')).toBe(false)
  })

  it('数字与字符串比较：跨类型按字符串比，避免 1 == true 这种坑', () => {
    expect(yes('$count == 3')).toBe(true)
    expect(yes('$count > 2')).toBe(true)
    expect(yes('$count <= 3')).toBe(true)
    expect(yes('$countStr == 3')).toBe(true)
    expect(yes('$count == true')).toBe(false)
  })

  it('字符串字面量与变量比较', () => {
    expect(yes("$username == 'alice'")).toBe(true)
    expect(yes('$username != "bob"')).toBe(true)
    expect(yes("$username == 'alice' and $count == 3")).toBe(true)
    expect(yes("$username == 'bob' or $count == 3")).toBe(true)
  })

  it('括号改变优先级', () => {
    expect(yes("($username == 'bob' or $count == 3) and $logged_in")).toBe(true)
    expect(yes("$username == 'bob' or $count == 3 and $logged_in")).toBe(true)
    expect(yes("$username == 'bob' or ($count == 3 and not $logged_in)")).toBe(false)
  })

  it('exists / empty 后缀', () => {
    expect(yes('$username exists')).toBe(true)
    expect(yes('$missing exists')).toBe(false)
    expect(yes('$emptyText empty')).toBe(true)
    expect(yes('$username empty')).toBe(false)
    expect(yes('nothing exists')).toBe(false) // 裸单词等价于 $nothing
  })

  it('点号变量名（$a.b）能取到', () => {
    expect(yes("$a.b == 'dotted'")).toBe(true)
  })

  it('未定义变量参与比较时按空串处理，不抛异常', () => {
    expect(yes('$nope == ""')).toBe(true)
    expect(yes('$nope exists')).toBe(false)
  })

  it('语法错误必须回报错误而不是静默为真', () => {
    expect(evalCondition("$username ==", vars).error).toBeTruthy()
    expect(evalCondition('(1 == 1', vars).error).toContain('括号')
    expect(evalCondition("'未闭合", vars).error).toContain('引号')
    expect(evalCondition('$', vars).error).toContain('变量名')
    expect(evalCondition('1 == 1 2', vars).error).toContain('多余内容')
    expect(evalCondition('@@@', vars).error).toContain('无法识别')
  })

  it('绝不执行宿主代码：条件里写 JS 只会报错', () => {
    const r = evalCondition('require("fs")', vars)
    expect(r.error).toBeTruthy()
    expect(r.value).toBe(false)
  })
})

describe('变量插值', () => {
  it('${name} 与 $name 都支持', () => {
    expect(interpolate('你好 ${username}', vars).text).toBe('你好 alice')
    expect(interpolate('你好 $username', vars).text).toBe('你好 alice')
    expect(interpolate('${count}+${countStr}', vars).text).toBe('3+3')
  })

  it('未定义变量替换成空串并回报名字', () => {
    const r = interpolate('值=${nope}', vars)
    expect(r.text).toBe('值=')
    expect(r.missing).toEqual(['nope'])
  })

  it('null 变量替换成空串且不算缺失', () => {
    const r = interpolate('[${nothing}]', vars)
    expect(r.text).toBe('[]')
    expect(r.missing).toEqual([])
  })

  it('没有占位符时原样返回', () => {
    expect(interpolate('https://example.com/', vars).text).toBe('https://example.com/')
  })
})