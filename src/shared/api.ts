/** 自动化 API（本机 Local API）的共用契约 */

export interface ApiStatus {
  running: boolean
  port: number | null
  baseUrl: string | null
  /** 是否已配置 Token（配置后所有 /api/v1/* 都要带） */
  authRequired: boolean
  tokenConfigured: boolean
  requests: number
  enabled: boolean
  configuredPort: number
  /**
   * Token 本身**不在这里**。
   * 状态对象会被界面轮询、可能被任意渲染进程代码读到；
   * Token 只在用户显式点「显示」时通过 api:revealToken 单独取一次。
   */
}