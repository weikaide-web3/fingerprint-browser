/**
 * HTTP 请求头的共用契约。
 *
 * 为什么单独一层：Google 与 X（前置 Cloudflare）除了看 TLS/H2，还看
 * **请求头的顺序与大小写**。同一个 Chrome 版本发出的顺序是固定代码路径产出的，
 * 而 curl / Go / Python / 各类代理改写出来的顺序与大小写都不一样。
 * JS 层完全读不到自己发出的头部顺序，所以只能在内核连接经过我们手时被动观测。
 */

export interface HttpHeaderLine {
  /** 线上原样大小写（大小写本身就是指纹） */
  raw: string
  /** 小写名，比对用 */
  name: string
  value: string
}

export interface HttpRequestHeaders {
  /** '1.1' | '2' */
  httpVersion: string
  method: string
  path: string
  headers: HttpHeaderLine[]
}