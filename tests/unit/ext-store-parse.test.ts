import { describe, it, expect } from 'vitest'
import { parseStoreId, guessNameFromUrl, storeUrlFor } from '../../src/main/extensions/parse'

describe('Chrome 应用商店扩展 ID 解析', () => {
  const ID = 'cjpalhdlnbpafiamejdnhcphjbkeiagm' // uBlock Origin

  it('解析新版商店 URL', () => {
    expect(parseStoreId(`https://chromewebstore.google.com/detail/u-block-origin/${ID}`)).toBe(ID)
  })

  it('解析旧版商店 URL', () => {
    expect(parseStoreId(`https://chrome.google.com/webstore/detail/u-block-origin/${ID}`)).toBe(ID)
  })

  it('裸 32 位 ID', () => {
    expect(parseStoreId(ID)).toBe(ID)
  })

  it('忽略 query 与 hash 与结尾斜杠', () => {
    expect(parseStoreId(`https://chromewebstore.google.com/detail/x/${ID}?hl=zh-CN`)).toBe(ID)
    expect(parseStoreId(`https://chromewebstore.google.com/detail/x/${ID}#reviews`)).toBe(ID)
    expect(parseStoreId(`https://chromewebstore.google.com/detail/x/${ID}/`)).toBe(ID)
  })

  it('前后空白被 trim', () => {
    expect(parseStoreId(`  ${ID}  `)).toBe(ID)
  })

  it('非法输入抛错', () => {
    expect(() => parseStoreId('')).toThrow(/请输入/)
    expect(() => parseStoreId('https://chromewebstore.google.com/category/extensions')).toThrow(/无法识别/)
    expect(() => parseStoreId('not-an-id')).toThrow(/无法识别/)
    // 含非 a-p 字母的 32 位串不是合法 ID
    expect(() => parseStoreId('abcdefghijklmnopqrstuvwxyz123456')).toThrow(/无法识别/)
  })

  it('guessNameFromUrl 从 slug 推断可读名称', () => {
    expect(guessNameFromUrl(`https://chromewebstore.google.com/detail/u-block-origin/${ID}`, ID)).toBe('u block origin')
    expect(guessNameFromUrl(ID, ID)).toBe(ID)
  })

  it('storeUrlFor 生成规范商店链接', () => {
    expect(storeUrlFor(ID)).toBe(`https://chromewebstore.google.com/detail/${ID}`)
  })
})
