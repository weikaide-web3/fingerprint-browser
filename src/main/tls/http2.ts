import type { Http2Fingerprint, Http2Priority, Http2SettingItem } from '@shared/tls'

/**
 * HTTP/2 客户端前置帧序列解析（Akamai 式指纹）。
 *
 * Chrome 的 H2 指纹由三件事决定，且都与「浏览器版本」绑定：
 *   S = SETTINGS 的参数与**出现顺序**
 *   P = 建流时的优先级树（RFC 7540 客户端会预分配 2/4/6... 的依赖）
 *   W = 连接级 WINDOW_UPDATE 的增量（Chrome 用固定值，不同版本不同）
 * 服务端（Cloudflare / Google）把这三段拼起来就是一个稳定的设备级标识。
 *
 * 注意：TLS 之下这些帧是加密的，只有在「我们终结 TLS」时才看得到，
 * 所以本模块既支持从明文 socket 字节解析，也支持从对端 SETTINGS 对象构造。
 */

export const H2_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'

export const FRAME = {
  DATA: 0x0,
  HEADERS: 0x1,
  PRIORITY: 0x2,
  RST_STREAM: 0x3,
  SETTINGS: 0x4,
  PUSH_PROMISE: 0x5,
  PING: 0x6,
  GOAWAY: 0x7,
  WINDOW_UPDATE: 0x8,
  CONTINUATION: 0x9
} as const

export const SETTING_NAME: Record<number, string> = {
  1: 'HEADER_TABLE_SIZE',
  2: 'ENABLE_PUSH',
  3: 'INITIAL_WINDOW_SIZE',
  4: 'MAX_FRAME_SIZE',
  5: 'MAX_HEADER_LIST_SIZE',
  6: 'ENABLE_CONNECT_PROTOCOL',
  7: 'UNKNOWN_SETTING_7',
  8: 'ENABLE_CONNECT_PROTOCOL',
  9: 'DUPLEX'
}

export class H2ParseError extends Error {}

export interface Frame {
  type: number
  flags: number
  stream: number
  payload: Buffer
}

/** 从字节流里逐帧解析；字节不够时返回已解析的部分并把 consumed 报给调用方 */
export function parseFrames(buf: Buffer, max = 32): { frames: Frame[]; consumed: number } {
  const frames: Frame[] = []
  let p = 0
  while (p + 9 <= buf.length && frames.length < max) {
    const len = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]
    const type = buf[p + 3]
    const flags = buf[p + 4]
    const stream = ((buf[p + 5] & 0x7f) << 24) | (buf[p + 6] << 16) | (buf[p + 7] << 8) | buf[p + 8]
    if (p + 9 + len > buf.length) break // 帧还没收全
    frames.push({ type, flags, stream, payload: buf.subarray(p + 9, p + 9 + len) })
    p += 9 + len
  }
  return { frames, consumed: p }
}

function settingsOf(payload: Buffer): Http2SettingItem[] {
  const out: Http2SettingItem[] = []
  // 每项 6 字节（id u16 + value u32）；用 i+6<=len 而不是 i+5<len，
  // 否则最后一项在 len 不是 6 的倍数时会被丢掉
  for (let i = 0; i + 6 <= payload.length; i += 6) {
    out.push({ id: payload.readUInt16BE(i), value: payload.readUInt32BE(i + 2) })
  }
  return out
}

/**
 * 从「已解析的前置帧」产出指纹。
 *
 * 单独拆出来是因为实测发现：node 的 http2 服务器会在内部消费掉 socket 字节，
 * 外部监听器一个字节都收不到（见 tests/integration/tmp-h2getter.test.ts）。
 * 所以观测 H2 必须自己终结 TLS + 自己解析帧，那时手里拿的已经是解析好的帧，
 * 而不是原始字节 —— 这条路径才是实际用的那条。
 */
export function fingerprintFromFrames(frames: Frame[]): Http2Fingerprint | null {
  const settings: Http2SettingItem[] = []
  const priorities: Http2Priority[] = []
  const preludeFrames: number[] = []
  let windowUpdate: number | null = null

  for (const f of frames) {
    if (f.type === FRAME.HEADERS) break
    preludeFrames.push(f.type)
    if (f.type === FRAME.SETTINGS && !(f.flags & 0x1)) settings.push(...settingsOf(f.payload))
    if (f.type === FRAME.PRIORITY) {
      const parent = f.payload.readUInt32BE(0)
      priorities.push({
        stream: f.stream,
        parent: parent & 0x7fffffff,
        exclusive: (parent & 0x80000000) !== 0,
        weight: f.payload[4]
      })
    }
    if (f.type === FRAME.WINDOW_UPDATE && f.stream === 0 && f.payload.length >= 4) {
      const inc = f.payload.readUInt32BE(0) & 0x7fffffff
      if (windowUpdate === null) windowUpdate = inc
    }
  }

  return {
    preface: true,
    settings,
    priorities,
    preludeFrames,
    windowUpdate,
    fp: h2FpString({ settings, priorities, preludeFrames, windowUpdate })
  }
}

/**
 * 解析客户端前置（preface + 前置帧），产出 Akamai 风格的 H2 指纹。
 * 不是 h2 连接时返回 null（而不是抛错）——调用方按「未观测到」处理。
 */
export function fingerprintH2Client(buf: Buffer): Http2Fingerprint | null {
  if (buf.length < H2_PREFACE.length) return null
  if (buf.subarray(0, H2_PREFACE.length).toString('latin1') !== H2_PREFACE) return null
  return fingerprintFromFrames(parseFrames(buf.subarray(H2_PREFACE.length)).frames)
}

/**
 * 规范化字符串。刻意保留顺序：顺序变了就是换了内核。
 */
export function h2FpString(f: Pick<Http2Fingerprint, 'settings' | 'priorities' | 'preludeFrames' | 'windowUpdate'>): string {
  const s = f.settings.map((x) => `${x.id}:${x.value}`).join(',')
  const p = f.priorities.map((x) => `${x.stream}:${x.parent}:${x.exclusive ? 1 : 0}:${x.weight}`).join(',')
  const a = f.preludeFrames.join(',')
  const w = f.windowUpdate === null ? '' : String(f.windowUpdate)
  return `S=${s};P=${p};A=${a};W=${w}`
}

/** 从对端 SETTINGS 对象构造（拿不到顺序与 WINDOW_UPDATE 时的降级形态） */
export function h2FromRemoteSettings(settings: Record<string, number | boolean | undefined>): Http2Fingerprint {
  const items: Http2SettingItem[] = []
  const map: Record<string, number> = {
    headerTableSize: 1,
    enablePush: 2,
    initialWindowSize: 3,
    maxFrameSize: 4,
    maxHeaderListSize: 5
  }
  for (const [name, id] of Object.entries(map)) {
    const v = settings[name]
    // 只记录显式改过的项：Chrome 不会把默认值全发一遍，缺项本身就是信息
    if (v === undefined) continue
    // Node 的 remoteSettings 会把 enablePush / enableConnectProtocol 归一成 boolean，
    // 直接塞进 value 会让指纹串变成 "2:true" —— 与线上字节解析出的 "2:0" 对不上。
    items.push({ id, value: typeof v === 'boolean' ? (v ? 1 : 0) : v })
  }
  return { preface: true, settings: items, priorities: [], preludeFrames: [FRAME.SETTINGS], windowUpdate: null, fp: h2FpString({ settings: items, priorities: [], preludeFrames: [FRAME.SETTINGS], windowUpdate: null }) }
}

/** 人类可读的 SETTINGS 列表（UI 展示用） */
export function describeSettings(items: Http2SettingItem[]): string {
  return items.map((s) => `${SETTING_NAME[s.id] ?? `0x${s.id.toString(16)}`}=${s.value}`).join(' · ')
}