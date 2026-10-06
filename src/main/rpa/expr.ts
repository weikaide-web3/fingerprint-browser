/**
 * RPA 条件表达式：安全求值（绝不 eval 用户字符串）。
 *
 * 支持：$变量、数字、'字符串'、== != > >= < <=、and / or / not、括号，
 * 以及后缀 exists / empty（判断变量是否存在 / 是否为空）。
 * 之所以自己写解析器，是因为条件一旦走 eval，就等于把任意 JS 注入主进程。
 */

export type Value = string | number | boolean | null

export interface EvalResult {
  value: boolean
  error: string | null
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'op'; value: string }
  | { kind: 'kw'; value: 'and' | 'or' | 'not' | 'true' | 'false' | 'exists' | 'empty' }
  | { kind: 'paren'; value: '(' | ')' }

const TWO_CHAR_OPS = ['==', '!=', '>=', '<=']
const ONE_CHAR_OPS = ['>', '<']

function tokenize(src: string): Token[] | string {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '(' || ch === ')') {
      out.push({ kind: 'paren', value: ch as '(' | ')' })
      i += 1
      continue
    }
    if (ch === '!' && src[i + 1] !== '=') {
      out.push({ kind: 'kw', value: 'not' })
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== quote) {
        s += src[j]
        j += 1
      }
      if (j >= src.length) return '字符串字面量缺少结束引号'
      out.push({ kind: 'str', value: s })
      i = j + 1
      continue
    }
    if (ch === '$') {
      let j = i + 1
      let name = ''
      while (j < src.length && /[\w.[\]-]/.test(src[j])) {
        name += src[j]
        j += 1
      }
      if (!name) return '$ 后面要跟变量名'
      out.push({ kind: 'var', name })
      i = j
      continue
    }
    const two = src.slice(i, i + 2)
    if (TWO_CHAR_OPS.includes(two)) {
      out.push({ kind: 'op', value: two })
      i += 2
      continue
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      out.push({ kind: 'op', value: ch })
      i += 1
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i
      let num = ''
      while (j < src.length && /[0-9.]/.test(src[j])) {
        num += src[j]
        j += 1
      }
      const n = Number(num)
      if (Number.isNaN(n)) return `非法数字：${num}`
      out.push({ kind: 'num', value: n })
      i = j
      continue
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i
      let word = ''
      while (j < src.length && /[\w-]/.test(src[j])) {
        word += src[j]
        j += 1
      }
      const lower = word.toLowerCase()
      if (['and', 'or', 'not', 'true', 'false', 'exists', 'empty'].includes(lower)) {
        out.push({ kind: 'kw', value: lower as 'and' | 'or' | 'not' | 'true' | 'false' | 'exists' | 'empty' })
      } else {
        // 裸单词按变量名处理（$ 可省），于是能写 `logged_in exists`
        out.push({ kind: 'var', name: word })
      }
      i = j
      continue
    }
    return `无法识别的字符：${ch}`
  }
  return out
}

function toBool(v: Value): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  return !(s === '' || s === 'false' || s === '0' || s === 'null' || s === 'undefined')
}

function compare(a: Value, b: Value, op: string): boolean {
  const numeric = typeof a === 'number' && typeof b === 'number'
  const left = numeric ? (a as number) : String(a ?? '')
  const right = numeric ? (b as number) : String(b ?? '')
  switch (op) {
    case '==':
      return left === right
    case '!=':
      return left !== right
    case '>':
      return left > right
    case '>=':
      return left >= right
    case '<':
      return left < right
    case '<=':
      return left <= right
    default:
      return false
  }
}

/**
 * 解析错误用独立类型表示：Value 本身可以是字符串（'abc'、''），
 * 所以不能拿字符串当错误标记 —— 否则空字符串字面量会被当成错误。
 */
interface ParseError {
  readonly __err: string
}
type Parsed = Value | ParseError

const err = (msg: string): ParseError => ({ __err: msg })
const isErr = (v: Parsed): v is ParseError => typeof v === 'object' && v !== null && '__err' in v

class Parser {
  private pos = 0
  constructor(
    private tokens: Token[],
    private vars: Record<string, Value>
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }
  private take(): Token | undefined {
    return this.tokens[this.pos++]
  }
  private isKw(kw: string): boolean {
    const t = this.peek()
    return t?.kind === 'kw' && t.value === kw
  }

  parseOr(): Parsed {
    let left = this.parseAnd()
    if (isErr(left)) return left
    while (this.isKw('or')) {
      this.take()
      const right = this.parseAnd()
      if (isErr(right)) return right
      left = toBool(left) || toBool(right)
    }
    return left
  }

  private parseAnd(): Parsed {
    let left = this.parseNot()
    if (isErr(left)) return left
    while (this.isKw('and')) {
      this.take()
      const right = this.parseNot()
      if (isErr(right)) return right
      left = toBool(left) && toBool(right)
    }
    return left
  }

  private parseNot(): Parsed {
    if (this.isKw('not')) {
      this.take()
      const v = this.parseNot()
      if (isErr(v)) return v
      return !toBool(v)
    }
    return this.parseComparison()
  }

  private parseComparison(): Parsed {
    const left = this.parseUnary()
    if (isErr(left)) return left
    const t = this.peek()
    if (t?.kind === 'op') {
      this.take()
      const right = this.parseUnary()
      if (isErr(right)) return right
      return compare(left, right, t.value)
    }
    return left
  }

  private parseUnary(): Parsed {
    const t = this.peek()
    if (t?.kind === 'paren' && t.value === '(') {
      this.take()
      const v = this.parseOr()
      if (isErr(v)) return v
      const close = this.take()
      if (!close || close.kind !== 'paren' || close.value !== ')') return err('括号没有闭合')
      return v
    }
    if (t?.kind === 'kw' && (t.value === 'true' || t.value === 'false')) {
      this.take()
      return t.value === 'true'
    }
    if (t?.kind === 'num' || t?.kind === 'str') {
      this.take()
      return t.value
    }
    if (t?.kind === 'var') {
      this.take()
      const name = t.name
      const v = this.vars[name]
      const has = v !== null && v !== undefined
      const next = this.peek()
      if (next?.kind === 'kw' && next.value === 'exists') {
        this.take()
        return has
      }
      if (next?.kind === 'kw' && next.value === 'empty') {
        this.take()
        return !has || String(v) === ''
      }
      return has ? v : null
    }
    return err('表达式不完整')
  }

  rest(): Token | undefined {
    return this.peek()
  }
}

export function evalCondition(src: string, vars: Record<string, Value>): EvalResult {
  const trimmed = String(src ?? '').trim()
  if (!trimmed) return { value: true, error: null }
  const tokens = tokenize(trimmed)
  if (typeof tokens === 'string') return { value: false, error: tokens }
  if (!tokens.length) return { value: true, error: null }
  const parser = new Parser(tokens, vars)
  const value = parser.parseOr()
  if (isErr(value)) return { value: false, error: value.__err }
  const leftover = parser.rest()
  if (leftover) return { value: false, error: `表达式后面有多余内容：${JSON.stringify(leftover)}` }
  return { value: toBool(value), error: null }
}

/** 把 ${name} / $name 替换成变量值；未定义的变量替换成空串并回报缺失名 */
export function interpolate(text: string, vars: Record<string, Value>): { text: string; missing: string[] } {
  const missing: string[] = []
  const out = String(text ?? '').replace(
    /\$\{([A-Za-z0-9_.-]+)\}|\$([A-Za-z0-9_.-]+)/g,
    (_m, a: string | undefined, b: string | undefined) => {
      const name = a ?? b ?? ''
      if (!Object.prototype.hasOwnProperty.call(vars, name)) {
        missing.push(name)
        return ''
      }
      const v = vars[name]
      return v === null || v === undefined ? '' : String(v)
    }
  )
  return { text: out, missing }
}