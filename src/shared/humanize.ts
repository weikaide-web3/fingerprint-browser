/**
 * 行为人类化配置（主进程执行 + 渲染进程编辑共用）。
 *
 * 为什么必须做：Google / X 的风控不只看静态指纹，还看**事件流**。
 * Playwright 默认的 click 是「瞬移到元素中心 + 一次 mousedown/up」，
 * 没有 mousemove、坐标永远是元素正中、两次事件间隔 0ms —— 这是教科书级的机器人特征。
 * 这里把「鼠标轨迹 / 点击落点 / 打字节奏 / 动作间停顿」都做成可配置的真实行为。
 */

export type HumanizePreset = 'off' | 'light' | 'standard' | 'aggressive'

export interface HumanizeConfig {
  preset: HumanizePreset
  /** 关闭时全部为 false，走原生瞬时操作 */
  enabled: boolean
  /** 鼠标移动：沿贝塞尔曲线补发 mousemove */
  mouseMove: boolean
  /** 曲线上的采样点数量范围 */
  mouseSteps: [number, number]
  /** 鼠标移动总耗时范围（毫秒） */
  mouseDurationMs: [number, number]
  /** 点击落点：在元素内随机取点（而不是永远正中心） */
  randomClickPoint: boolean
  /** 点击前停顿：人眼定位 + 犹豫（毫秒） */
  preClickDwellMs: [number, number]
  /** 按下与抬起之间的间隔（毫秒） */
  clickHoldMs: [number, number]
  /** 逐字输入而不是 fill() 一次性塞进去 */
  typeCharByChar: boolean
  /** 每个字符之间的间隔（毫秒） */
  charDelayMs: [number, number]
  /** 输入时偶尔打错再删掉（非常人类，但会改变最终值，默认关） */
  typoSimulation: boolean
  /** 打字前停顿（毫秒） */
  preTypeDwellMs: [number, number]
  /** 动作之间的随机停顿（毫秒），替代固定 sleep */
  actionGapMs: [number, number]
  /** 页面滚动也用渐进式而不是瞬间 scrollTo */
  smoothScroll: boolean
}

export const HUMANIZE_PRESETS: Record<HumanizePreset, HumanizeConfig> = {
  off: {
    preset: 'off',
    enabled: false,
    mouseMove: false,
    // 关闭档刻意把区间全设为 0：语义上「不注入任何额外延迟」，
    // 也让「预设从弱到强单调递增」这条不变量成立（否则 off 的随机区间反而比 light 大）。
    mouseSteps: [0, 0],
    mouseDurationMs: [0, 0],
    randomClickPoint: false,
    preClickDwellMs: [0, 0],
    clickHoldMs: [0, 0],
    typeCharByChar: false,
    charDelayMs: [0, 0],
    typoSimulation: false,
    preTypeDwellMs: [0, 0],
    actionGapMs: [0, 0],
    smoothScroll: false
  },
  light: {
    preset: 'light',
    enabled: true,
    mouseMove: true,
    mouseSteps: [6, 12],
    mouseDurationMs: [90, 220],
    randomClickPoint: true,
    preClickDwellMs: [40, 160],
    clickHoldMs: [30, 80],
    typeCharByChar: false,
    charDelayMs: [40, 140],
    typoSimulation: false,
    preTypeDwellMs: [80, 260],
    actionGapMs: [120, 420],
    smoothScroll: false
  },
  standard: {
    preset: 'standard',
    enabled: true,
    mouseMove: true,
    mouseSteps: [14, 30],
    mouseDurationMs: [220, 620],
    randomClickPoint: true,
    preClickDwellMs: [120, 420],
    clickHoldMs: [45, 120],
    typeCharByChar: true,
    charDelayMs: [55, 190],
    typoSimulation: false,
    preTypeDwellMs: [220, 700],
    actionGapMs: [300, 1100],
    smoothScroll: true
  },
  aggressive: {
    preset: 'aggressive',
    enabled: true,
    mouseMove: true,
    mouseSteps: [24, 52],
    mouseDurationMs: [420, 1100],
    randomClickPoint: true,
    preClickDwellMs: [260, 900],
    clickHoldMs: [60, 160],
    typeCharByChar: true,
    charDelayMs: [80, 320],
    typoSimulation: true,
    preTypeDwellMs: [400, 1200],
    actionGapMs: [700, 2400],
    smoothScroll: true
  }
}

export const DEFAULT_HUMANIZE: HumanizeConfig = HUMANIZE_PRESETS.standard

export function presetConfig(preset: HumanizePreset): HumanizeConfig {
  return HUMANIZE_PRESETS[preset] ?? DEFAULT_HUMANIZE
}