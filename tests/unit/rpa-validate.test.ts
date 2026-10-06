import { describe, it, expect } from 'vitest'
import { validateFlow, precheckConditions, describeStep } from '../../src/main/rpa/validate'
import { sampleFlow } from '../../src/main/rpa/sample'
import type { RpaFlow, RpaStep } from '@shared/rpa'

/**
 * 流程静态校验单测。
 * 目标是「点运行之前就把低级错误挑出来」，所以每一项都要确认它既会报错，
 * 又不会把合法的写法误判成错误（误判会让人懒得看校验结果）。
 */

const flow = (steps: RpaStep[], extra: Partial<RpaFlow> = {}): RpaFlow => ({
  version: 1,
  name: '测试流程',
  steps,
  ...extra
})

const errorsOf = (f: RpaFlow): string[] => validateFlow(f).issues.filter((i) => i.level === 'error').map((i) => i.message)

describe('RPA 流程校验', () => {
  it('合法流程：0 错误', () => {
    const f = flow([
      { id: 'a', type: 'goto', url: 'https://example.com/' },
      { id: 'b', type: 'click', selector: '#go' },
      { id: 'c', type: 'fill', selector: '#q', value: 'hi' },
      {
        id: 'd',
        type: 'if',
        condition: '$x exists',
        then: [{ id: 'd1', type: 'log', message: '有 x' }],
        else: [{ id: 'd2', type: 'sleep', ms: 100 }]
      },
      { id: 'e', type: 'loop', times: 2, steps: [{ id: 'e1', type: 'click', selector: '.next' }] }
    ])
    const v = validateFlow(f)
    expect(v.issues.map((i) => `${i.level}:${i.message}`)).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.stepCount).toBe(8)
  })

  it('缺名 / 空流程都算错误', () => {
    expect(errorsOf({ version: 1, name: '  ', steps: [{ id: 'a', type: 'sleep', ms: 1 }] })).toContain('流程缺少名称')
    expect(errorsOf(flow([]))).toContain('流程没有任何步骤')
  })

  it('需要选择器的步骤缺 selector 会被指出', () => {
    const errs = errorsOf(flow([{ id: 'a', type: 'click', selector: '  ' } as unknown as RpaStep]))
    expect(errs.some((m) => m.includes('click 缺少 selector'))).toBe(true)
  })

  it('goto 的 url 校验：缺协议 / javascript: / 非法地址', () => {
    expect(errorsOf(flow([{ id: 'a', type: 'goto', url: '' }]))).toContain('缺少 url')
    expect(errorsOf(flow([{ id: 'a', type: 'goto', url: 'javascript:alert(1)' }])))
      .toContain('不允许 javascript: 地址')
    expect(errorsOf(flow([{ id: 'a', type: 'goto', url: 'ftp://x/y' }]))).toContain('不支持的协议：ftp:')
    expect(errorsOf(flow([{ id: 'a', type: 'goto', url: 'not a url' }])))
      .toEqual([expect.stringContaining('url 无法解析')])
    expect(errorsOf(flow([{ id: 'a', type: 'goto', url: 'file:///tmp/a.html' }]))).toEqual([])
  })

  it('各步骤的必填项缺失都会报错', () => {
    const errs = errorsOf(
      flow([
        { id: 'a', type: 'fill', selector: '#x', value: undefined as unknown as string },
        { id: 'b', type: 'press', key: '' },
        { id: 'c', type: 'text', selector: '#x', variable: '' },
        { id: 'd', type: 'attribute', selector: '#x', attribute: '', variable: 'v' },
        { id: 'e', type: 'assertText', expected: undefined as unknown as string },
        { id: 'f', type: 'sleep', ms: 0 },
        { id: 'g', type: 'evaluate', expression: '  ' }
      ])
    )
    expect(errs.length).toBe(7)
  })

  it('步骤 id 重复会被指出（日志与失败定位会混乱）', () => {
    const errs = errorsOf(flow([{ id: 'x', type: 'sleep', ms: 1 }, { id: 'x', type: 'sleep', ms: 2 }]))
    expect(errs.some((m) => m.includes('步骤 id 重复'))).toBe(true)
  })

  it('条件语法错误在静态阶段就能发现', () => {
    const errs = errorsOf(
      flow([{ id: 'a', type: 'if', condition: '$x ==', then: [] }, { id: 'b', type: 'loop', times: 2, untilCondition: '(', steps: [] }])
    )
    expect(errs.some((m) => m.startsWith('if 条件有误'))).toBe(true)
    expect(errs.some((m) => m.startsWith('loop 退出条件有误'))).toBe(true)
  })

  it('循环次数非法报错，过大只警告', () => {
    expect(errorsOf(flow([{ id: 'a', type: 'loop', times: 0, steps: [] }]))).toContain('loop 次数必须是 >= 1 的整数')
    const big = validateFlow(flow([{ id: 'a', type: 'loop', times: 500, steps: [{ id: 'a1', type: 'sleep', ms: 1 }] }]))
    expect(big.errors).toBe(0)
    expect(big.warns).toBe(1)
  })

  it('未声明的变量只警告，不阻断（可能由前面的步骤写入）', () => {
    const v = validateFlow(flow([{ id: 'a', type: 'goto', url: 'https://example.com/?q=${keyword}' }], { params: {} }))
    expect(v.errors).toBe(0)
    expect(v.warns).toBe(1)
    expect(v.issues[0].message).toContain('keyword')
    const declared = validateFlow(flow([{ id: 'a', type: 'goto', url: 'https://example.com/?q=${keyword}' }], { params: { keyword: 'x' } }))
    expect(declared.warns).toBe(0)
  })

  it('嵌套过深会被拒绝', () => {
    let inner: RpaStep[] = [{ id: 'leaf', type: 'sleep', ms: 1 }]
    for (let i = 0; i < 8; i += 1) inner = [{ id: `n${i}`, type: 'loop', times: 1, steps: inner }]
    const v = validateFlow(flow(inner))
    expect(v.errors).toBeGreaterThan(0)
    expect(v.issues.some((i) => i.message.includes('嵌套超过'))).toBe(true)
  })

  it('precheckConditions 把错误定位到具体步骤', () => {
    const f = flow([
      { id: 'ok', type: 'if', condition: '$a exists', then: [{ id: 'ok2', type: 'log', message: 'x' }] },
      { id: 'bad', type: 'if', condition: '$a ==', then: [] }
    ])
    const issues = precheckConditions(f, { a: '1' })
    expect(issues.length).toBe(1)
    expect(issues[0].stepId).toBe('bad')
    expect(issues[0].path).toBe('if#bad')
  })

  it('describeStep 给没写 label 的步骤一个可读描述', () => {
    expect(describeStep({ id: 'a', type: 'goto', url: 'https://a.test/' })).toBe('打开 https://a.test/')
    expect(describeStep({ id: 'b', type: 'click', selector: '#x' })).toBe('点击 #x')
    expect(describeStep({ id: 'c', type: 'text', selector: '#x', variable: 'v' })).toBe('抓取文本 #x → $v')
    expect(describeStep({ id: 'd', type: 'sleep', ms: 250 })).toBe('等待 250ms')
    expect(describeStep({ id: 'e', type: 'log', message: 'hi', label: '自定义说明' })).toBe('自定义说明')
  })

  it('url 里的变量占位在静态阶段不做解析（否则示例流程会被误判）', () => {
    const withParam = flow([{ id: 'a', type: 'goto', url: '${target}' }], { params: { target: 'https://example.com/' } })
    expect(errorsOf(withParam)).toEqual([])
    // 变量由前面的步骤写入时也允许：静态阶段没法展开，只做危险协议检查
    expect(errorsOf(flow([{ id: 'a', type: 'goto', url: '${base}/x' }]))).toEqual([])
    expect(errorsOf(flow([{ id: 'a', type: 'goto', url: 'javascript:alert(1)' }])).length).toBe(1)
    expect(errorsOf(flow([{ id: 'a', type: 'goto', url: 'javascript:${code}' }])).length).toBe(1)
  })

  it('内置示例流程必须始终通过校验：界面「从示例新建」直接依赖它', () => {
    const v = validateFlow(sampleFlow())
    expect(v.issues.filter((i) => i.level === 'error').map((i) => `${i.message} @ ${i.path}`)).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.stepCount).toBe(6)
    // 示例里 ${title} 由 s3 写入，不在 params 里 —— 应当只提示，不阻断
    expect(v.warns).toBe(1)
  })
})