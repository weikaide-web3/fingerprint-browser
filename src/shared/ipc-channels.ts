/** IPC 通道名常量，主/渲染共用 */
export const IPC = {
  // app
  APP_GET_INFO: 'app:getInfo',
  APP_GET_SETTINGS: 'app:getSettings',
  APP_SET_SETTING: 'app:setSetting',
  // settings（带定义与校验）
  SETTINGS_VIEW: 'settings:view',
  SETTINGS_SET: 'settings:set',
  SETTINGS_RESET: 'settings:reset',
  // profiles
  PROFILE_LIST: 'profile:list',
  PROFILE_GET: 'profile:get',
  PROFILE_CREATE: 'profile:create',
  PROFILE_UPDATE: 'profile:update',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_DUPLICATE: 'profile:duplicate',
  PROFILE_GENERATE_FINGERPRINT: 'profile:generateFingerprint',
  PROFILE_VALIDATE_FINGERPRINT: 'profile:validateFingerprint',
  // groups & tags
  GROUP_LIST: 'group:list',
  GROUP_CREATE: 'group:create',
  GROUP_UPDATE: 'group:update',
  GROUP_DELETE: 'group:delete',
  TAG_LIST: 'tag:list',
  TAG_CREATE: 'tag:create',
  TAG_DELETE: 'tag:delete',
  // proxies
  PROXY_LIST: 'proxy:list',
  PROXY_USAGE: 'proxy:usage',
  PROXY_BOUND: 'proxy:bound',
  PROXY_CREATE: 'proxy:create',
  PROXY_UPDATE: 'proxy:update',
  PROXY_DELETE: 'proxy:delete',
  PROXY_CHECK: 'proxy:check',
  PROXY_CHECK_ALL: 'proxy:checkAll',
  PROXY_IMPORT: 'proxy:import',
  // browser control
  BROWSER_START: 'browser:start',
  BROWSER_STOP: 'browser:stop',
  BROWSER_STOP_ALL: 'browser:stopAll',
  BROWSER_ACTIVE: 'browser:active',
  // BROWSER_CLEAR_CACHE 已移除（空实现）；清缓存走 SESSION_CLEANUP 的 target='cache'
  // cookie / session
  SESSION_STATS_ALL: 'session:statsAll',
  SESSION_STATS: 'session:stats',
  SESSION_REFRESH: 'session:refresh',
  SESSION_EXPORT: 'session:export',
  SESSION_IMPORT: 'session:import',
  SESSION_CLEAR: 'session:clear',
  SESSION_CLEANUP: 'session:cleanup',
  SESSION_SET_POLICY: 'session:setPolicy',
  SESSION_SET_RETENTION: 'session:setRetention',
  SESSION_RETENTION_ALERTS: 'session:retentionAlerts',
  SESSION_KEY_PRESETS: 'session:keyPresets',
  // 账号保管
  ACCOUNT_LIST: 'account:list',
  ACCOUNT_GET: 'account:get',
  ACCOUNT_CREATE: 'account:create',
  ACCOUNT_UPDATE: 'account:update',
  ACCOUNT_DELETE: 'account:delete',
  ACCOUNT_TOTP: 'account:totp',
  ACCOUNT_PLAN: 'account:plan',
  ACCOUNT_COUNTS: 'account:counts',
  ACCOUNT_CONFLICTS: 'account:conflicts',
  // 关联隔离
  ASSOC_CHECK: 'assoc:check',
  ASSOC_CHECK_PROFILE: 'assoc:checkProfile',
  // TLS / HTTP2 指纹
  TLS_PROBE: 'tls:probe',
  TLS_BASELINE_PROMOTE: 'tls:baseline:promote',
  TLS_BASELINE_LIST: 'tls:baseline:list',
  TLS_HISTORY: 'tls:history',
  // 内核层能力与剩余风险
  KERNEL_REPORT: 'kernel:report',
  KERNEL_USE_BRANDED: 'kernel:useBranded',
  KERNEL_CLEAR_OVERRIDE: 'kernel:clearOverride',
  KERNEL_SET_PREFER_BRANDED: 'kernel:setPreferBranded',
  // 指纹检测
  DETECT_RUN: 'detect:run',
  // 自动化 API
  API_STATUS: 'api:status',
  API_START: 'api:start',
  API_STOP: 'api:stop',
  API_RESTART: 'api:restart',
  API_GENERATE_TOKEN: 'api:generateToken',
  API_REVEAL_TOKEN: 'api:revealToken',
  // RPA
  RPA_LIST: 'rpa:list',
  RPA_GET: 'rpa:get',
  RPA_CREATE: 'rpa:create',
  RPA_UPDATE: 'rpa:update',
  RPA_DELETE: 'rpa:delete',
  RPA_VALIDATE: 'rpa:validate',
  RPA_RUN: 'rpa:run',
  RPA_STOP: 'rpa:stop',
  RPA_RUNS: 'rpa:runs',
  RPA_RUN_LOG: 'rpa:runLog',
  RPA_SAMPLE: 'rpa:sample',
  // 扩展管理
  EXT_LIST: 'ext:list',
  EXT_INSTALL: 'ext:install',
  EXT_UNINSTALL: 'ext:uninstall',
  EXT_TOGGLE: 'ext:toggle',
  EXT_BIND: 'ext:bind',
  EXT_UNBIND: 'ext:unbind',
  EXT_BOUND_PROFILES: 'ext:boundProfiles',
  EXT_USAGE: 'ext:usage',
  EXT_INSTALL_STORE: 'ext:installStore',
  EXT_INSTALL_IN_PROFILE: 'ext:installInProfile',
  EXT_STORE_STATUS: 'ext:storeStatus',
  // 定时调度
  SCHED_LIST: 'sched:list',
  SCHED_CREATE: 'sched:create',
  SCHED_UPDATE: 'sched:update',
  SCHED_DELETE: 'sched:delete',
  SCHED_TOGGLE: 'sched:toggle',
  SCHED_RUN_NOW: 'sched:runNow',

  // Passkey / WebAuthn：服务层早已实现并有集成测试，但一直没有界面入口，
  // 用户无法注册 passkey —— 而 README 把 M13 标成已完成。这里补齐通道。
  WEBAUTHN_STATUS: 'webauthn:status',
  WEBAUTHN_LIST: 'webauthn:list',
  WEBAUTHN_ISSUES: 'webauthn:issues',
  WEBAUTHN_ENROLL: 'webauthn:enroll',
  WEBAUTHN_VERIFY: 'webauthn:verify',
  WEBAUTHN_REMOVE: 'webauthn:remove',
  // 备份 / 恢复
  BACKUP_LIST: 'backup:list',
  BACKUP_CREATE: 'backup:create',
  BACKUP_RESTORE: 'backup:restore',
  BACKUP_DELETE: 'backup:delete',
  BACKUP_REVEAL: 'backup:reveal',
  // 健康度
  HEALTH_SUMMARY: 'health:summary',
  HEALTH_PROFILE: 'health:profile',
  // 资源监控
  RESOURCES_REPORT: 'resources:report',
  // 环境导入 / 导出
  PORT_EXPORT: 'port:export',
  PORT_IMPORT: 'port:import',
  // 操作历史
  HISTORY_LIST: 'history:list',
  // 后台监控告警
  MONITOR_ALERTS: 'monitor:alerts',
  MONITOR_RUN_PROXY: 'monitor:runProxyCheck',
  MONITOR_RUN_COOKIE: 'monitor:runCookieCheck',
  MONITOR_RUN_DRIFT: 'monitor:runDriftCheck',
  // 回收站
  TRASH_LIST: 'trash:list',
  TRASH_RESTORE: 'trash:restore',
  TRASH_PURGE: 'trash:purge',
  TRASH_EMPTY: 'trash:empty',
  // 本机文件对话框（导出/导入走系统面板，不把路径暴露给渲染进程）
  APP_SAVE_TEXT: 'app:saveText',
  APP_PICK_TEXT: 'app:pickText',
  APP_PICK_DIRECTORY: 'app:pickDirectory',
  APP_REVEAL_PATH: 'app:revealPath',
  // events pushed from main
  EVT_STATUS: 'evt:status',
  EVT_LOG: 'evt:log',
  EVT_RPA_STEP: 'evt:rpaStep',
  EVT_RELOAD: 'evt:reload'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
