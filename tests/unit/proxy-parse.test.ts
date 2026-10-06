import { describe, it, expect } from 'vitest'
import { validateProxyInput, parseProxyLine } from '../../src/main/proxy/parse'

describe('代理输入校验', () => {
  it('接受标准 IPv4 + 端口', () => {
    const v = validateProxyInput({ scheme: 'http', host: '1.2.3.4', port: 8080 })
    expect(v.host).toBe('1.2.3.4')
    expect(v.port).toBe(8080)
    // 没填名字时用地址兜底，列表里不会出现空白行
    expect(v.name).toBe('http://1.2.3.4:8080')
  })

  it('接受域名与 IPv6（存裸地址，不带方括号）', () => {
    expect(validateProxyInput({ scheme: 'socks5', host: 'proxy.example.com', port: 1080 }).host).toBe(
      'proxy.example.com'
    )
    expect(validateProxyInput({ scheme: 'socks5', host: '[2001:db8::1]', port: 1080 }).host).toBe('2001:db8::1')
  })

  it('容忍用户把整条 socks5://host:port 粘进地址框', () => {
    const v = validateProxyInput({ scheme: 'socks5', host: 'socks5://10.0.0.1:1080', port: 1080 })
    expect(v.host).toBe('10.0.0.1')
  })

  it('地址里的协议与所选协议冲突时报错', () => {
    expect(() => validateProxyInput({ scheme: 'http', host: 'socks5://10.0.0.1', port: 1080 })).toThrow(/不一致/)
  })

  it('接受地址里连端口一起粘贴，并从地址取端口', () => {
    expect(validateProxyInput({ scheme: 'http', host: '10.0.0.1:8080', port: 8080 }).port).toBe(8080)
    // 端口框留空时，地址里的端口就是答案
    expect(validateProxyInput({ scheme: 'socks5', host: '10.0.0.1:1080' }).port).toBe(1080)
  })

  it('端口框与地址里的端口冲突时报错，不猜', () => {
    expect(() => validateProxyInput({ scheme: 'http', host: '10.0.0.1:8080', port: 9090 })).toThrow(/不一致/)
  })

  it('两处都没有端口时报错', () => {
    expect(() => validateProxyInput({ scheme: 'http', host: '10.0.0.1' })).toThrow(/端口/)
  })

  it('拒绝路径、空格、内嵌凭据', () => {
    expect(() => validateProxyInput({ scheme: 'http', host: '10.0.0.1/path', port: 80 })).toThrow(/路径/)
    expect(() => validateProxyInput({ scheme: 'http', host: '10. 0.0.1', port: 80 })).toThrow(/空格/)
    expect(() => validateProxyInput({ scheme: 'http', host: 'user:pass@10.0.0.1', port: 80 })).toThrow(/账号密码/)
  })

  it('端口范围与非整数', () => {
    for (const port of [0, -1, 65536, 80.5, NaN]) {
      expect(() => validateProxyInput({ scheme: 'http', host: '10.0.0.1', port })).toThrow(/端口/)
    }
  })

  it('未知协议被拒', () => {
    expect(() =>
      validateProxyInput({ scheme: 'socks4a' as 'http', host: '10.0.0.1', port: 1080 })
    ).toThrow(/协议/)
  })

  it('接受 socks5h 协议', () => {
    const v = validateProxyInput({ scheme: 'socks5h', host: '1.2.3.4', port: 1080 })
    expect(v.scheme).toBe('socks5h')
    expect(v.name).toBe('socks5h://1.2.3.4:1080')
  })

  it('socks5h 容忍用户把 socks5h://host:port 粘进地址框', () => {
    const v = validateProxyInput({ scheme: 'socks5h', host: 'socks5h://10.0.0.1:1080', port: 1080 })
    expect(v.host).toBe('10.0.0.1')
  })

  it('socks5h 与 socks5 协议冲突时报错', () => {
    expect(() => validateProxyInput({ scheme: 'socks5', host: 'socks5h://10.0.0.1', port: 1080 })).toThrow(/不一致/)
  })

  it('空 host / 空输入不炸', () => {
    expect(() => validateProxyInput(null)).toThrow()
    expect(() => validateProxyInput({ scheme: 'http', host: '', port: 80 })).toThrow(/不能为空/)
  })

  it('空字符串账号归一为 null（而不是空账号）', () => {
    expect(validateProxyInput({ scheme: 'http', host: '10.0.0.1', port: 80, username: '  ' }).username).toBeNull()
    expect(validateProxyInput({ scheme: 'http', host: '10.0.0.1', port: 80, username: ' u1' }).username).toBe('u1')
  })

  it('password 未提供时保持 undefined，让调用方能区分「不改」和「清空」', () => {
    expect(validateProxyInput({ scheme: 'http', host: '10.0.0.1', port: 80 }).password).toBeUndefined()
    expect(validateProxyInput({ scheme: 'http', host: '10.0.0.1', port: 80, password: null }).password).toBeNull()
  })
})

describe('代理导入行解析', () => {
  it('host:port', () => {
    expect(parseProxyLine('1.2.3.4:8080')).toMatchObject({ scheme: 'http', host: '1.2.3.4', port: 8080 })
  })

  it('host:port:user:pass', () => {
    expect(parseProxyLine('1.2.3.4:8080:u:p')).toMatchObject({ host: '1.2.3.4', port: 8080, username: 'u', password: 'p' })
  })

  it('scheme://user:pass@host:port', () => {
    expect(parseProxyLine('socks5://u:p@1.2.3.4:1080')).toMatchObject({
      scheme: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'u',
      password: 'p'
    })
  })

  it('密码里含冒号时不被截断', () => {
    expect(parseProxyLine('socks5://u:a:b:c@1.2.3.4:1080').password).toBe('a:b:c')
  })

  it('解析 socks5h:// 协议', () => {
    const v = parseProxyLine('socks5h://u:p@1.2.3.4:1080')
    expect(v).toMatchObject({ scheme: 'socks5h', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' })
  })

  it('IPv6 带方括号', () => {
    expect(parseProxyLine('[2001:db8::1]:1080')).toMatchObject({ host: '[2001:db8::1]', port: 1080 })
  })

  it('缺端口 / 字段过多时报错', () => {
    expect(() => parseProxyLine('1.2.3.4')).toThrow(/缺少端口/)
    expect(() => parseProxyLine('a:1:u:p:extra')).toThrow(/字段过多/)
  })

  it('解析结果可直接喂给校验（两种格式互通）', () => {
    const v = validateProxyInput(parseProxyLine('socks5://u:p@1.2.3.4:1080'))
    expect(v).toMatchObject({ scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' })
  })
})
