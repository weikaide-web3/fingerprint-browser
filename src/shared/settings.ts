/** 设置模块的共用契约（主进程定义 + 渲染进程渲染） */

export type SettingType = 'string' | 'number' | 'boolean' | 'select' | 'secret'
export type SettingGroup =
  | '内核'
  | '启动参数'
  | '代理'
  | '自动化 API'
  | '自动化'
  | '会话与检测'
  | '关联隔离'
  | 'TLS / HTTP2'
  | '后台监控'
  | '其它'

export interface SettingOption {
  value: string
  label: string
}

export interface SettingView {
  key: string
  label: string
  description: string
  group: SettingGroup
  type: SettingType
  /** 默认值 */
  def: string | number | boolean | null
  /** 当前生效值 */
  value: string | number | boolean | null
  options?: SettingOption[]
  /** 改动后需要重启应用 / 重启环境才生效 */
  restart?: 'app' | 'profile'
  readonly?: boolean
  isDefault: boolean
  /**
   * secret 类型专用：当前是否已设置值。
   * secret 的真实值**不会**出现在 value 里（value 恒为空串），
   * 否则渲染进程轮询设置页就能读到 API Token 等机密。
   */
  secretSet?: boolean
}