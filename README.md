# 指纹浏览器（macOS Anti-Detect Browser）

对标 AdsPower / MoreLogin 的 macOS 多账号指纹浏览器工作台。
技术栈：**Electron 44 + Playwright/Chromium + React 19 + TypeScript + SQLite + Tailwind CSS 4**。

## 当前状态

**22 个功能模块全部实现完毕**，界面 20 个页面都是真实功能页（无占位页）。
自动化验证全绿：

| 层级 | 规模 | 说明 |
|------|------|------|
| 单元测试 | **479 项 / 32 个文件** | 纯逻辑，不启动内核，约 7 秒 |
| 集成测试 | **38 项 / 10 个文件** | 真实启动 Chromium，验证注入 / 登录态 / 检测 / API / RPA / TLS / WebAuthn |
| UI E2E | **9 个阶段** | 构建产物后用 Playwright 驱动界面走完整流程，含 19 页导航断言 |
| 类型检查 | 0 error | `tsconfig.node.json` 与 `tsconfig.web.json` 分别检查 |

> 表中每个数字都由脚本从代码统计得出，不是估值；复现命令见「数字从哪来」。

| # | 模块 | 状态 | 说明 |
|---|------|------|------|
| M1 | 骨架：Electron + electron-vite + React + Tailwind | ✅ | 类型化 IPC（统一 `{ok,data/error}` 包装）、单实例锁 |
| M2 | 数据层：SQLite（better-sqlite3，WAL + 版本化迁移） | ✅ | 14 个迁移、21 张表，外键级联 + 日志保留 |
| M3 | 环境管理：CRUD + 分组/标签 + 批量创建 + 详情编辑 | ✅ | 26 个指纹配置段逐项编辑、一致性体检 |
| M4 | 内核与启动器：内核发现 + spawn + `connectOverCDP` | ✅ | 正式版 Chrome / Chrome for Testing / Playwright Chromium |
| M5 | 指纹引擎：seed 确定性生成 + CDP/JS 双层注入 | ✅ | 10 个补丁模块，同一环境跨进程重启信号完全一致 |
| M6 | 登录态（Cookie / Storage） | ✅ | storageState + Netscape 双格式导入导出、保留策略与关键键保护 |
| M7 | 代理管理 + 本机 relay + IP 质量检测 | ✅ | HTTP / HTTPS / SOCKS5 / SOCKS5H / SOCKS4；带凭据的代理经本机 relay，DNS 不泄漏 |
| M8 | 指纹检测 | ✅ | 内置探针页在真实内核采样 49 组信号，与 profile 期望逐项比对 52 项 |
| M9 | 自动化 API（AdsPower 兼容） | ✅ | `/api/v1/browser/start` 等，Token + Host 白名单 + 跨站拦截 |
| M10 | RPA 流程编排 | ✅ | 18 种步骤 + 条件/循环/重试 + 4 级人类化预设，在指定环境的内核里执行 |
| M11 | 设置 | ✅ | 32 项集中定义 + 写入校验 + secret 类型脱敏 |
| M12 | TLS / HTTP2 指纹观测 | ✅ | 被动观测 ClientHello（JA3/JA4/JA4r）+ H2 SETTINGS + 基线比对 |
| M13 | WebAuthn / Passkey | ✅ | CDP 虚拟认证器 + 凭证持久化 + 跨重启重新注入 + 断言验证 + 独立管理页 |
| M14 | 账号保管 | ✅ | 加密存储 + TOTP 生成 + 自动填充计划 + 同账号多环境冲突检测 |
| M15 | 关联隔离 | ✅ | 环境↔代理↔账号三元组分析（12 类风险）+ RPA 运行前闸门 |
| M16 | 内核能力矩阵 | ✅ | 15 个检测向量分层评估 + 一键切换正式版 Chrome |
| M17 | 扩展管理 | ✅ | 解包扩展或 Chrome 应用商店扩展、绑定环境、启动时 `--load-extension` 注入 |
| M18 | 定时调度 | ✅ | 自研 cron 解析器 + 定时执行 RPA 流程 + 下次运行时间计算 |
| M19 | 备份 / 恢复 | ✅ | `app.db`（在线备份 API）+ `profiles/` 打成 zip；恢复前自动反向快照 |
| M20 | 环境健康度 | ✅ | 指纹一致性 + 代理质量 + 会话新鲜度 + 关联风险综合评分（O(N) 一次装配） |
| M21 | 监控告警 | ✅ | 代理失效 / Cookie 过期 / 指纹漂移巡检 + 日志与观测数据保留 |
| M22 | 运维辅助 | ✅ | 托盘 + 崩溃恢复 + 资源监控 + 操作历史 + 导入导出 + 回收站 + 错误边界 |

## 运行

```bash
npm install          # postinstall 自动 electron-builder install-app-deps 重建原生模块
npm run dev          # 开发模式（热更新）
npm run build        # 产物输出到 out/
npm run typecheck    # node / renderer 两套 tsconfig 分别检查
npm run test         # 单元 + 集成（会真实启动 Chromium，约 60 秒）
npm run test:unit    # 只跑纯逻辑单测（不启动内核，最快）
npm run test:integration
npm run test:e2e     # 构建后驱动界面跑完整流程
npm run dist         # 打包 DMG（electron-builder）
```

> Electron 二进制下载慢时：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`

## 安全模型

这一节是本轮严格审查后新增的。之前的实现「功能都对，但边界没守住」，
下面每一条都有对应的回归测试。

### 进程与生命周期

- **单实例锁**：`app.requestSingleInstanceLock()`。两个实例同时跑会各自打开同一个
  `user-data-dir`，Chromium 的 `SingletonLock` 冲突会导致登录态写回损坏；
  第二个实例现在只聚焦已有窗口。
- **退出清理只走一条路径**：`runTeardown()` 用独立的 `teardownStarted` 标志守卫
  （不复用 `isQuitting`，否则托盘退出会跳过清理），依次停调度 → 停监控 → 停 API →
  关全部环境 → 销毁托盘 → 关数据库。首次调用 `preventDefault()`，并挂一个 10 秒
  强制 `app.exit(0)` 兜底，清理卡死也不会留下挂死的进程。
- **谁拉起谁关闭**：`launchProfile` 返回 `spawned` 标志。`withContext` 只有在真的
  spawn 了进程时才 `stopProfile`。修掉的是这个场景：自动化 API 正在启动环境 A，
  同时一个检测操作也走 `withContext`，跑完把 API 刚拉起的内核关掉 ——
  用户侧症状是「脚本连不上」，日志里完全看不出是谁关的。
- **并发上限在启动临界区内检查**：`maxConcurrentProfiles` 的判断挪进 `doLaunch`，
  避免两个并发请求都通过检查后一起超限。

### 路径与启动参数

- **环境 id 白名单**：`assertSafeId()` 只允许 `[A-Za-z0-9_-]{1,64}`。
  所有派生路径（`user-data` / `session` / `downloads` / `extensions`）都经过它。
  `ProfileInput.id` 是可选的（克隆 / 导入 / 迁移会指定 id），而这个 id 会被拼进
  `user-data-dir`，且清理与崩溃恢复会对该目录**递归删除** ——
  所以 `createProfile({ id: '../../../../tmp/evil' })` 这种输入必须挡掉，
  否则一次删除环境就能删掉数据目录之外的任意目录。
  自动化 API 的 `/user/create` 目前不接收 id，但校验放在 `createProfile` 里，
  任何新增的调用方（含渲染进程直接走 IPC）都自动受保护。
- **用户自定义参数过白名单过滤**：`fp.launch.args` 与 `profile.launchArgs` 现在都走
  `sanitizeUserArgs()`，挡掉 `--user-agent`、`--no-sandbox`、`--proxy-server`、
  `--remote-debugging-port`、`--user-data-dir` 等会顶掉托管值的开关。
  `disableFeatures` 保持原样，因为每一项都被固定前缀 `--disable-blink-features=` 包住，
  拼不出别的开关。
- **下载目录按环境隔离，用 CDP 而不是命令行**：
  `Browser.setDownloadBehavior`（经 `browser.newBrowserCDPSession()`）把下载路径设成
  `profiles/<id>/downloads`。之前用的 `--download-path=` **根本不是 Chromium 开关**，
  参数被静默忽略，所有环境的下载都落进系统默认下载夹。
  （教训：`strings` 扫二进制来找 Chromium 开关会漏报，必须实测。）
- **`revealPath` 限定根目录**：只允许在数据目录、备份目录、profiles 根目录下定位文件，
  防止界面被诱导打开任意路径。

### 自动化 API

只监听 `127.0.0.1` 并不等于安全 —— 浏览器里的任意网页都能发简单请求。三层防护：

1. **Host 白名单**（先于一切，包括 `/health`）：只接受 `127.0.0.1` / `localhost` / `::1`。
   否则 DNS rebinding 可以让恶意域名先解析到公网通过校验、再指回 127.0.0.1，
   浏览器会把响应当同源数据读走 —— `/user/list` 会泄漏全部环境名、代理 host:port 与指纹 seed。
2. **跨站请求拦截**：`/browser/start|stop|open`、`/user/create|update|delete` 这 6 条
   状态变更路由，识别到「浏览器发起的跨站请求」就 403。
   判定依据是 `Sec-Fetch-Site` / `Sec-Fetch-Mode` / `Origin` / `Referer`，
   而不是 HTTP method —— 所以 `<img src="http://127.0.0.1:52222/api/v1/user/delete?user_id=x">`
   被挡住，而 AdsPower 的 GET 调用习惯、以及 curl / Postman / Selenium 脚本完全不受影响。
3. **Token 不再出现在界面数据里**：`api.status()` 不返回 token，
   查看要走独立的 `api.revealToken()`（并写审计日志）。
   首次启动 API 时若 `apiToken` 从未写入过会自动生成一个。

同理，`app.getSettings` / `app.setSetting` 这对 IPC 被整体删除：
前者会把 `apiToken` 明文送到渲染进程，后者绕过所有写入校验。
设置读写改走 `settings.view` / `settings.set` / `settings.reset`。

### 机密存储

- **`type: 'secret'` 的设置不回显**：`settingsView()` 对 secret 项恒返回 `value: ''`，
  用 `secretSet: true` 标记「已设置」。界面上是只写输入框（占位符「已设置（留空保持不变）」
  + 清除按钮），截图/录屏不会带出 token。
  有一条测试遍历所有 secret 定义，防止将来新增字段漏掉脱敏。
- **加密降级必须可见**：`safeStorage`（macOS Keychain）不可用时，凭据以 `plain:` 前缀明文落库。
  现在 `hasPlaintextSecrets()` 会扫描 4 个机密列，`encryptionStatus()` 给出结论，
  界面顶部显示琥珀色告警条。
- **passkey 私钥不出主进程**：`webauthn.list()` 返回 `WebAuthnCredentialView`
  （`hasPrivateKey: boolean`，不含私钥本身），渲染进程拿不到私钥。
- **备份用数据库 API**：备份包是 `app.db` + `profiles/`（用 macOS `ditto` 打成 zip），
  其中 `app.db` 走 `getDb().backup(dest)` 产生一致性快照，
  而不是在 WAL 模式下裸复制文件（会漏掉 `-wal` 里的内容）。
  恢复是破坏性操作：先把当前数据反向备份一份（pre-restore）再覆盖；
  数据库仍处于打开状态时调用 `restore()` 直接报错，避免覆盖正在使用的库。

### 数据完整性

- **外键 + 级联删除**（迁移 14）：`webauthn_credentials` 与 `tls_observations` 原本
  没有外键约束，删环境后 passkey 私钥会永久残留。现在重建为
  `REFERENCES profiles(id) ON DELETE CASCADE`，并先清掉已有孤儿行。
- **日志保留**：审计日志 5000 / 使用日志 20000 / RPA 运行记录 500，
  后台每 24 小时裁剪一次（TLS 观测同样裁剪）。之前这些表只增不减。
- **删除死表**：`proxy_groups`、`api_keys` 从未被任何代码读写，迁移 14 一并 DROP。

### 一个只在打包版出现的缺陷

`hasPlaintextSecrets()` 原先用 `require('../db')` 取数据库句柄。
electron-vite 把主进程打成单个 `out/main/index.js`，这个相对路径的 require 会原样保留，
运行时按 `out/main/` 解析必然 MODULE_NOT_FOUND，而外层 `try/catch` 把它吞成 `return false` ——
**结果是明文机密告警在开发环境正常、在打包版永久静默失效**。
现已改为静态 import，并加了一条扫描 `src/` 的守卫测试
（外部包如 `better-sqlite3` 的懒加载 require 是正确的，不在禁止范围）。

## 已实现的指纹项

**CDP 覆盖**：User-Agent、Client Hints（`userAgentMetadata`，含 `getHighEntropyValues`）、
时区、locale、地理位置、附加请求头、CSP。

**document-start JS 补丁**（`src/main/fingerprint/patches/`，10 个模块共 1280 行）：

| 补丁模块 | 覆盖信号 |
|----------|----------|
| `navigator` | webdriver / userAgent / appVersion / platform / languages / hardwareConcurrency / deviceMemory / maxTouchPoints / doNotTrack / GPC / plugins / mimeTypes / permissions.query / `window.chrome` |
| `screen` | width / height / avail* / colorDepth / pixelDepth / orientation / devicePixelRatio |
| `webgl` | UNMASKED_VENDOR/RENDERER、getSupportedExtensions、getExtension、getParameter 表 |
| `webgpu` | adapter.vendor / architecture / device / description / powerPreference |
| `canvas` | getImageData / toDataURL / toBlob / measureText 确定性噪声 |
| `audio` | AudioBuffer.getChannelData / OfflineAudioContext.startRendering 确定性噪声、sampleRate / channelCount |
| `fonts` | document.fonts.check / FontFaceSet 列表 |
| `webrtc` | RTCPeerConnection ICE candidate 过滤 / 本地 IP 掩码 / publicIp 替换 |
| `stealth` | cdc_ 属性清除 / chrome 对象补全 / visibilityState / matchMedia / speechSynthesis / PaymentRequest / MediaCapabilities / console 加固 |
| `misc` | Battery、Network Information、mediaDevices.enumerateDevices、storage.estimate、performance.memory |

所有噪声由 profile 的 `seed` 推导，**同一环境每次运行输出完全一致**（已由跨进程重启测试验证）。

**指纹配置**（`src/shared/fingerprint.ts`，29 个 interface）：
`FingerprintConfig` 有 30 个字段 —— 4 个元信息（`version` / `seed` / `kernel` / `mode`）
加 **26 个配置段**：
ua、clientHints、screen、webgl、webgpu、canvas、audio、fonts、webrtc、geolocation、
mediaDevices、battery、hardware、timezone、language、headers、storage、connection、
privacy、plugins、permissions、stealth、machine、webauthn、performance、launch。

## 关键设计

1. **auto 模式对齐内核真实版本**：`detectKernelVersion()` 读取 Chromium 的 `Info.plist`，
   UA 与 Client Hints 天然一致，避免最常见的穿帮点。
2. **真实 CDP 端点**：启动时分配 `--remote-debugging-port`，返回
   `ws://127.0.0.1:<port>/devtools/browser/<id>`，Local API 直接把它交给 Puppeteer/Selenium。
3. **seed 确定性**：`createRng(seed)` 与注入脚本内的 `mulberry32` 使用同一算法族，保证可复现。
4. **原生模块懒加载**：`better-sqlite3` 按 Electron ABI 编译，`db/index.ts` 在
   `openDatabase()` 内部 `require` 它，使纯 Node 测试链不会被 ABI 阻断。
   （注意：只有外部包这样处理，内部模块必须静态 import —— 见「安全模型」最后一节。）
5. **一切以真实内核为准**：登录态读写、指纹检测、RPA 执行都走 `browser/with-context.ts` ——
   环境在跑就复用它的 context，没跑就临时拉起同一个 profile，用完按所有权关闭。
   同一环境的并发临时操作按 profileId 串行，避免互相踩内核。
6. **headless 默认关闭**：渲染管线、`requestAnimationFrame` 时序、serviceWorker 注册、
   GPU 光栅化路径都与有头模式不同，Google / X 会把它们当成另一类设备。
   声明了 `realSite` 的操作（登录、发帖、RPA）即使用户打开 `transientHeadless` 也强制有头。
7. **检测与注入共用一张规则表**：`detect/compare.ts` 是纯函数，界面展示的比对结果和
   集成测试断言的是同一套逻辑 —— 测试通过就等于界面通过。
8. **带凭据的代理走本机 relay**：Chrome 的 `--proxy-server` 不接受账号密码、
   SOCKS5 认证完全不支持，因此让内核连本机 `socks5://127.0.0.1:<port>`，由 relay 补认证，
   并强制 `--host-resolver-rules=MAP * ~NOTFOUND` 防止 DNS 泄漏。
   `socks5h`（远端 DNS）在无认证场景下也自动注入该规则。
9. **出口质量判定会说明自己的置信度**：判定依赖 `usageType` / `hosting` / `proxy` /
   `mobile` / `anycast` / `reverse` 六个信号，但免费探测点（如 ip-api 免费版）不返回全部。
   缺失的字段会记进 `signalsMissing` 并在结果里列出 `degraded`，
   避免把「探测点没数据」当成「确认不是机房」。
   探测点支持 https（自动走 TLS 并推 443 端口），配置无效时退回默认目标而不是报错。
10. **RPA 不 eval 用户条件**：条件与循环走自研求值器（`rpa/expr.ts`），
    运行前先静态校验（缺 selector、坏 URL、重复 id、未声明变量）。
11. **TLS 只观测不改写**：被动 tap 偷看 ClientHello 得到 JA3/JA4，本机 HTTP/2 源服务器读
    SETTINGS 帧。伪造的握手通常缺 GREASE、扩展顺序僵硬，比「内核版本与 UA 不一致」
    更容易被判定为机器人。`tls.autoBaseline` 在**比对之后**才建基线，避免内核给自己打分。
12. **WebAuthn 交接模式**：CDP 限制一个环境只能有一个 internal（平台）虚拟认证器，
    且按创建它的页面 target 作用域生效。因此采用 remove→add 交接，
    保证新页面注册/断言正常且 `authenticatorAttachment` 仍为 `platform`。
13. **关联闸门**：RPA 运行前自动检查环境↔代理↔账号三元组风险（12 类），
    存在 error 级问题时拒绝启动（可单次跳过）。
14. **内核能力矩阵**：把 JS 注入保护不到的地方（渲染管线、字体 shaping、Widevine、
    ClientHello）量化为 15 个向量的 covered/partial/kernel-only 状态，
    让用户知道该不该换正式版 Chrome 或自编译内核。
15. **自研 cron 解析器**：定时调度不引第三方库，`shared/cron.ts` 解析标准 5 段 cron
    （支持 `*` / `*/n` / `a-b` / `a,b,c`），纯函数计算下次运行时间，可在单测里完整覆盖。
16. **崩溃自愈**：启动时 `cleanupOrphanProcesses()` 扫描并清理上次异常退出残留的
    Chromium 进程与 profile 锁文件。先 `SIGTERM` 让 Chrome 写回 leveldb/Cookie，
    宽限期后仍存活才 `SIGKILL`。
17. **两种扩展加载方式**：解包扩展用 `--load-extension` 在启动时注入（仅本次启动）；
    Chrome 应用商店扩展无法用命令行加载，改为「在目标环境内打开商店页 → 用户点一次
    Add to Chrome → 原生安装进该 profile 的 user-data-dir」，因此跨重启保留且与真实用户
    安装路径一致。商店扩展记录只存元数据（name + storeId），不下载 CRX。
18. **渲染错误边界**：每个功能页用 `<ErrorBoundary key={nav}>` 包裹，
    单页抛错只白屏当前页并显示「重试」，不会拖垮整个应用；切换导航自动重置边界。
19. **删除进回收站**：环境 / 代理 / 扩展删除改为软删除（`deleted_at` 列），
    可在「回收站」页恢复或彻底清除。
20. **进程与定时器安全**：监控与调度用 `ticking` 标志防并发重入，
    `stopMonitor()` / `stopScheduler()` 清理所有 `setInterval`，退出时不留悬挂定时器。
21. **主进程不做长耗时同步调用**：`ps` 查询（`resources.ts`、`crash-recovery.ts`）与
    备份打包/解压（`backup.ts` 的 `ditto`、`profiles/` 递归复制）全部走异步版本 ——
    备份包含整个 `profiles/`，同步执行会把事件循环堵住几秒，期间窗口无响应、
    IPC 排队、内核 CDP 连接可能超时。`src/` 下已无 `execSync`；
    剩下的 `execFileSync` 只用于读 plist 版本号与生成临时证书这类毫秒级操作。
22. **健康度一次装配**：`summary()` 只查一次全部环境、一次会话统计、一次关联分析，
    再按环境切片（`sliceAssociation`），把原来的 O(N²) 降到 O(N)。

## 界面（20 个功能页）

| 页面 | 功能 |
|------|------|
| 环境管理 | 列表/搜索/分组/标签/批量创建/克隆/打开/关闭/批量启停/打开整组/导入导出/详情编辑（26 段指纹逐项编辑 + 一致性体检） |
| 代理管理 | CRUD + 批量导入 + 连通性检测 + IP 质量判定（residential/mobile/datacenter/anonymizer，含置信度降级说明）+ 绑定环境；协议 HTTP / HTTPS / SOCKS5 / SOCKS5H / SOCKS4 |
| Cookie / 会话 | 导出导入（storageState + Netscape）/ 清理 / 保留策略 / 关键键保护 / 到期提醒 |
| 指纹检测 | 真实内核采样 49 组信号，逐项与 profile 期望比对 52 项，给出 0-100 分 |
| TLS / HTTP2 | 被动观测 ClientHello（JA3/JA4/JA4r/H2fp）+ 基线比对 + 请求头顺序分析 + 回显服务交叉验证 |
| 内核能力 | 内核身份识别（flavor/version/branded/patched）+ 15 向量能力矩阵 + 一键切换正式版 Chrome |
| 扩展管理 | 安装解包扩展（解析 manifest）或粘贴 Chrome 应用商店链接/ID；启用禁用 + 绑定环境 |
| Passkey | 环境选择 + 认证器声明（model/AAGUID）+ 一致性告警 + 注册/验证/删除凭证 + 私钥在库状态 |
| 账号保管 | 加密存储 + TOTP 生成 + 自动填充计划 + 同账号多环境冲突检测 + 注册环境留痕 |
| 关联隔离 | 环境↔代理↔账号三元组分析 + 风险评分 + 运行前闸门 |
| 环境健康 | 每个环境的指纹一致性 / 代理质量 / 会话新鲜度 / 关联风险四维评分 + 总览 |
| 监控告警 | 代理失效 / Cookie 过期 / 指纹漂移巡检结果 + 手动触发 |
| 定时调度 | cron 定时执行 RPA 流程 + 启用暂停 + 立即运行 + 下次运行时间 |
| RPA | 流程编辑（18 种步骤）+ 静态校验 + 执行 + 步骤日志 + 人类化预设 + 关联闸门 |
| 资源监控 | 各环境 Chrome 进程数 / RSS 内存占用 + 总量 + 并发建议 |
| 操作历史 | 审计日志 + 使用日志时间线（打开/关闭/检测/设置变更） |
| 备份恢复 | 一键备份（数据库在线快照）+ 列表 + 恢复（覆盖前自动快照）+ 打开备份目录 |
| 回收站 | 环境 / 代理 / 扩展软删除后在此恢复或彻底清除 |
| 自动化 API | 启停控制 + Token 查看（独立审计）+ 端点文档 |
| 设置 | 32 项集中定义（10 组），写入校验，secret 只写不回显，重启提示 |

> 全局：`⌘F` 跨环境搜索、`⌘N` 新建环境、`⌘⇧Q` 关闭全部；关闭窗口最小化到系统托盘，后台常驻。
> 若检测到钥匙串不可用或库中仍有明文机密，页面顶部会显示告警条。

## 目录

```
src/main/
  browser/       launcher / registry / args / executable / with-context / crash-recovery
  fingerprint/   generator / datasets / injector / script / consistency / patches/*
  session/       cookies（解析与校验）/ disk（storageState 落盘）/ retention（保留策略）
  proxy/         checker（出口探测 + IP 质量判定 + 降级信号）/ parse / relay（本机 SOCKS5）
  detect/        probe（内置探针页）/ compare（期望 vs 实测，52 项规则）
  tls/           hello（ClientHello 解析）/ tap（被动观测）/ origin（本机 H2 源服务器）
                 / baseline（基线构建与比对）/ cert / http2
  webauthn/      attach（虚拟认证器挂载/交接）/ cbor（CBOR 解析）/ page（注册/断言脚本）
  association/   rules（三元组规则引擎）/ signal（信号摘要）
  kernel/        identity（内核身份识别）/ capability（15 向量能力矩阵）
  http/          headers（请求头顺序与大小写分析）
  rpa/           expr（条件求值）/ validate（静态校验）/ runner（执行器）/ humanize / sample
  api/           server（AdsPower 兼容 HTTP，可脱离 Electron 单测）
  settings/      defs（32 项集中定义 + 校验 + 默认值 + secret 脱敏）
  db/            index / migrations / sql/* / repositories/*（含 retention 日志裁剪）
  services/      profiles / browser / session / proxies / detect / api / rpa
                 / tls / webauthn / accounts / association / kernel / extensions
                 / scheduler / backup / health / monitor / resources / history / port
  ipc/           通道注册（统一 {ok,data|error} 包装）
  lib/           log / logging / crypto（含明文机密扫描）/ id
  totp.ts        TOTP 生成（RFC 6238）
  paths.ts       可注入的数据目录（测试友好）+ 环境 id 白名单
src/shared/      types / fingerprint / session / detect / rpa / api / settings
                 / tls / webauthn / association / kernel / account / http / humanize / lang / ops / cron
src/preload/     类型化 window.api
src/renderer/    React 管理界面（20 个功能页 + 对话框）
tests/
  unit/          32 个文件 479 项：生成器 / 一致性 / cookie / 代理 / 检测比对 / 设置
                 / API 与 CSRF / RPA 表达式与校验 / TLS / WebAuthn CBOR / TOTP / 人类化 / 关联
                 / IP 质量与降级 / cron / 健康度加权 / 环境导入导出 / 扩展商店 ID 解析
                 / 运维纯逻辑 / 数据库完整性与保留 / 启动安全 / 机密存储 / withContext 所有权
                 / 静态守卫（禁止内部 require）
  integration/   10 个文件 38 项：真实 Chromium 指纹注入 / 登录态 / 检测采样 / API 驱动
                 / RPA 执行 / TLS 观测 / WebAuthn 注册与断言 / Client Hints 线上验证
                 / 备份快照与恢复保护 / 回收站软删除
  e2e/           界面完整流程：建环境→启内核→换指纹→详情编辑→代理与 relay→检测
                 →RPA→API 鉴权→删除→19 页导航断言（每页专属控件 + aria-current + 高亮）
```

数据目录：`~/Library/Application Support/FingerprintBrowser/`

```
app.db (+ app.db-wal / app.db-shm)
profiles/<id>/user-data      Chromium profile（内核实际使用）
profiles/<id>/session        storageState 快照
profiles/<id>/downloads      该环境的下载目录（CDP 设置）
profiles/<id>/extensions     解包扩展
detect/                      探针页采样产物
rpa-runs/<runId>/            RPA 运行日志与截图
tls-probe/                   TLS 观测用的临时证书与探针页
```

备份在 `<数据目录>/../backups/fpb-backup-<时间戳>-<id>[-<名称>].zip`（刻意放在数据目录之外，避免备份套备份）。

## 自动化 API

```
GET  /health                                  存活探针（不需要 Token，仍校验 Host）
GET/POST /api/v1/browser/start   ?user_id=    返回 ws.selenium / ws.puppeteer / debug_port / pid
GET/POST /api/v1/browser/stop    ?user_id=
GET  /api/v1/browser/status      ?user_id=
GET  /api/v1/browser/active
GET/POST /api/v1/browser/open    ?user_id=&urls=
GET  /api/v1/user/list           ?page_no=&page_size=&browser_name=
POST /api/v1/user/create         browser_name=
POST /api/v1/user/update         user_id=
POST /api/v1/user/delete         user_id=
GET  /api/v1/ip/check            ?user_id=    走该环境的代理查出口
```

响应统一为 `{ code, msg, data }`（`code=0` 成功），与 AdsPower 一致，已有脚本改个 base_url 即可迁移。

**关于 method**：AdsPower 用 GET 调 `/browser/start`，为了兼容我们保留 GET。
但状态变更路由会识别「浏览器发起的跨站请求」并 403（依据 `Sec-Fetch-*` / `Origin` / `Referer`，
不看 method）—— 这样恶意网页塞 `<img>` 打不动本机 API，而脚本客户端完全不受影响。

**Token**：支持 `Authorization: Bearer <token>`、`?token=`、`x-api-key`。
首次启动 API 且 `apiToken` 从未写入过时会自动生成一个（`crypto.randomBytes(18)`）——
默认空 token 等于「全部接口无鉴权」，而这些接口能删环境、能让内核带某套指纹访问任意 URL。
用户显式把 token 清空则尊重其选择（`settingExists` 区分「从未配置」与「主动清空」）。
界面上 token 不回显，需要查看走「自动化 API」页的显式按钮（会写审计日志）。

## TLS / HTTP2 指纹

两条观测链路，各自回答一个不同的问题：

| 链路 | 路径 | 回答的问题 |
|------|------|------------|
| A. 内核一致性 | 环境 → 本机 tap（无上游）→ 本机 HTTP/2 源服务器 | 「这个内核本身长什么样」 |
| B. 出口链路 | 环境 → 本机 tap（上游 = 环境绑定的代理）→ 真实站点 | 「服务端实际看到的形状是什么」 |

A 与 B 的 JA4 不一致 → 中间有设备在做 TLS 终结（代理 MITM、企业网关、杀软）。

观测到的信号：JA3（原始 / 去 GREASE / 去 GREASE 且排序）、JA4、JA4r、
H2 SETTINGS 帧顺序、扩展线上顺序、GREASE 数量、请求头顺序与大小写。

刻意不做的事：**不改写 ClientHello**。伪造的握手通常缺 GREASE、扩展顺序僵硬，
比「内核版本与 UA 不一致」更容易被判定为机器人。

## WebAuthn / Passkey

Google 与 X 现在对新设备优先推 passkey。没有可注册的认证器，新设备登录就会被降级到
手机/邮箱验证 —— 而「需要手机验证」本身就是风控信号。

实现方式：CDP 的 WebAuthn 域提供虚拟认证器，密钥对由内核生成并保管。
持久化 credentialId + 私钥 + 公钥，下次启动时通过 `WebAuthn.addCredential` 重新注入 ——
保证「同一环境下次登录仍是同一把 passkey」。

关键约束（实测得到）：

- 一个环境只能有一个 internal（平台）虚拟认证器
- 认证器按创建它的 CDP 会话（页面 target）作用域生效
- 因此采用交接（handoff）模式：先从旧页面 remove，再在新页面 add
- 内核里没有任何认证器时 `navigator.credentials.create` 会永久挂住

安全边界：私钥只存主进程（`safeStorage` 加密），界面拿到的是 `WebAuthnCredentialView`，
只有 `hasPrivateKey` 布尔而没有密钥内容。`webauthn_credentials` 有指向 `profiles` 的
外键 + `ON DELETE CASCADE`，删环境必然连带清掉私钥。

## 关联隔离

Google 与 X 判定机器人时看的不是单个指纹，而是「账号-设备-出口」这个三元组的组合关系。
两个环境各自指纹完美，但只要它们共用一个出口 IP、或同一个账号在两个环境登录过，
服务端就能把这一批账号当成一个人操作。

规则引擎的 12 类风险代码：

| 代码 | 级别 | 含义 |
|------|------|------|
| `ACCOUNT_NO_PROXY` | warn | 账号未绑定代理 |
| `PROXY_SHARED` | warn / error | 代理上的账号数超过 `assoc.maxAccountsPerProxy`；出口是机房或匿名代理时升为 error |
| `FINGERPRINT_DUPLICATE` | error | 多个环境用同一个指纹 seed，Canvas/Audio/WebGL 噪声完全相同 |
| `FINGERPRINT_COLLISION` | warn | seed 不同但关键信号（UA/屏幕/WebGL/时区/语言）完全一致 |
| `ACCOUNT_MULTI_PROFILE` | error | 同一账号绑到多个环境（换设备登录） |
| `ACCOUNT_PROFILE_MOVED` | warn | 账号登录环境与注册环境不同 |
| `IP_HOSTING_WITH_ACCOUNT` | error | 机房 IP 上挂着账号 |
| `IP_PROXY_WITH_ACCOUNT` | warn | 匿名代理 / VPN 出口上挂着账号 |
| `IP_UNVERIFIED` | warn | 出口质量未验证 |
| `TZ_COUNTRY_MISMATCH` | warn | 时区与出口国家不一致 |
| `IP_ACCOUNT_LIMIT` | error | 单出口承载账号数超过 `assoc.maxAccountsPerIp` |
| `ACCOUNT_DORMANT` | info | 长期休眠账号（超过 `assoc.dormantDays`） |

RPA 运行前自动执行关联闸门：存在 error 级问题时拒绝启动（可单次跳过）。

## 内核能力矩阵

JS 注入能改的是「页面读到的值」，改不了「内核自己的行为」。15 个检测向量按层次评估：

| 层次 | 向量 | 状态 |
|------|------|------|
| network (4) | `ua.coherence`（UA/CH/TLS 三者版本一致）、`tls.clientHello`、`http2.settings`、`ip.quality` | covered / partial |
| js (6) | `automation.cdp`、`native.toString`、`events.trusted`、`webrtc.leak`、`clock.integrity`、`account.reputation` | covered / partial |
| kernel (5) | `render.pipeline`（BotGuard）、`webgl.readPixels`、`media.codecs`（Widevine）、`headless.shape`、`fonts.metrics` | partial / kernel-only |

只有自编译内核才能把 kernel-only 项升级为 covered。界面给出可执行动作（如「改用正式版 Chrome」）。

## 人类化行为

Google / X 的风控不只看静态指纹，还看事件流。Playwright 默认的 click 是
「瞬移到元素中心 + 一次 mousedown/up」—— 教科书级机器人特征。

4 级预设（off / light / standard / aggressive），覆盖：

- 鼠标沿贝塞尔曲线补发 mousemove（不是直线）
- 点击落点在元素内随机取点
- 逐字输入 + 字符间隔 + 打字前停顿
- 动作间随机停顿
- 渐进式滚动

同一 seed 得到同一套鼠标轨迹与打字节奏，便于复现问题。

## 本地使用增强（14 项）

面向「自己机器上长期跑」的场景补齐的运维与体验能力：

| # | 能力 | 实现要点 |
|---|------|----------|
| 1 | 系统托盘 + 最小化到托盘 | 关窗口不退出，常驻后台；托盘菜单：显示 / 关闭全部环境 / 退出 |
| 2 | 数据备份 / 恢复 | `getDb().backup()` 在线一致性快照；恢复前自动快照，可回退 |
| 3 | 崩溃恢复 | 启动时清理残留 Chromium 进程 + profile 锁文件（先 SIGTERM 再 SIGKILL） |
| 4 | RPA 定时调度 | 自研 cron 解析器 + 定时器；启用/暂停/立即运行/下次时间 |
| 5 | 环境健康度 | 指纹一致性 + 代理质量 + 会话新鲜度 + 关联风险四维加权评分 |
| 6 | 批量打开 / 关闭 | 多选后一键批量启停 |
| 7 | 全局搜索 + 快捷键 | `⌘F` 跨环境搜索、`⌘N` 新建、`⌘⇧Q` 关闭全部 |
| 8 | 资源监控 | 各环境 Chrome 进程数与 RSS 内存占用，提示并发上限 |
| 9 | 分组一键打开 | 选中分组后「打开本组」批量拉起该组全部环境 |
| 10 | 指纹漂移检测 | 检测分数写入基线，明显下降时告警 |
| 11 | 代理自动检测 | 后台定时巡检所有代理连通性，失效的标红 |
| 12 | Cookie 过期提醒 | 关键 Cookie 临近过期 / 已过期时提醒 |
| 13 | 环境导入 / 导出 | 单个环境完整导出（含指纹 + 代理 + 标签），方便迁移备份 |
| 14 | 操作历史 | 审计日志 + 使用日志时间线；三张日志表按上限自动裁剪 |

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 44.5 + electron-vite 4 |
| 浏览器内核 | Playwright Chromium 1.63（或本机正式版 Chrome） |
| UI | React 19.2 + Tailwind CSS 4.3 + Zustand 5 |
| 数据库 | better-sqlite3 13（WAL、外键、版本化迁移、在线备份） |
| HTTP API | Node 原生 `http` 模块（无框架依赖，可脱离 Electron 单测） |
| 校验 | 集中式纯函数校验（`settings/defs.ts` 的 `validate` + `rpa/validate.ts`），无运行时 schema 库 |
| 测试 | Vitest 5（`fileParallelism: false`，避免多个 Chromium 进程竞争） |
| 打包 | electron-builder 26（DMG + dir） |
| 日志 | electron-log 5 |

> 本轮清理掉的未使用依赖：`fastify`、`@fastify/cors`、`zod`、`dayjs`。
> 升级 Vitest 后，之前 2 个高危（`tinypool` / `vitest`）已清零；
> 剩余 8 个中等告警全部在 `electron-builder` / `@electron/get` 这条**仅构建期**的链上，
> 不进入打包产物。

## 代码规模

`src/` 共 **29,492 行** TypeScript（主进程 + 渲染进程 + 共享类型），
其中指纹补丁 10 个模块 1,280 行。
测试 `tests/` 另有 42 个文件 517 项断言。

### 数字从哪来

上面每个数字都可以用命令复现，别信文档不信代码：

```bash
grep -c "^  { id:" src/main/db/migrations.ts                              # 迁移数
grep -rho "CREATE TABLE IF NOT EXISTS [a-z_]*" src/main/db/sql/*.ts | sort -u | wc -l
                                                                          # 建表数（再减去迁移里的 DROP）
grep -c "^    key: '" src/main/settings/defs.ts                          # 设置项数
grep -n "label: '" src/renderer/src/App.tsx | wc -l                      # 导航页数
grep -oE "out\.[a-zA-Z]+ =" src/main/detect/probe.ts | sort -u | wc -l    # 探针信号组
grep -c "key: '" src/main/kernel/capability.ts                           # 能力向量
find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | tail -1           # 代码行数
npm run test                                                             # 测试总数
```

## 许可与使用边界

本项目以 **MIT** 许可开源（见 `LICENSE`）。多账号隔离本身是正当需求：
跨境电商店铺矩阵、广告素材与落地页验收、SEO/竞品调研、QA 自动化、
以及研究者观察「同一站点如何给不同访客分类」，都需要彼此独立的浏览器身份。

需要明确的是：

- 本仓库**不含任何运行时数据**。`app.db`、`profiles/`（真实 Chromium user-data）、
  代理与账号凭据、passkey 私钥全部在 `.gitignore` 里，不会进版本库。
- 代码不含任何真实代理端点、账号或密钥。测试与示例里出现的地址全是占位值：
  `127.0.0.1` / `localhost`、`example.com` / `a.test`、
  RFC 5737 文档段（`203.0.113.0/24`、`198.51.100.0/24`）、
  RFC 1918 内网段（`10.0.0.1`、`192.168.x.x`）与 `1.2.3.4` 这类惯用假地址，
  出口探测则由本地假出口服务（`tests/helpers/fake-proxies.ts`）提供，不依赖外网。
- 绕过访问控制、违反平台服务条款、批量注册/养号、刷量、规避风控封禁等行为
  由使用者自行承担，不在本项目的支持与背书范围内。
- 「指纹一致性」是中性能力：它同样让自动化脚本更容易被识别为真实用户，
  也更容易被识别为伪造设备 —— 项目里的检测页与内核能力矩阵就是用来
  量化这件事的，`kernel-only` 那一层 JS 注入永远补不齐。

## 后续可做的事（非阻塞）

1. 打包签名与公证（`npm run dist` 已配置，缺 Apple 开发者证书与 notarize 流程）
2. 团队共享（`users` / `shares` 表已建，界面与鉴权未接）
3. RPA 步骤录制（在真实内核里点选生成 selector）
4. 自编译补丁内核（把 kernel-only 向量升级为 covered）
5. 代理池自动轮换（对接 Bright Data / Smartproxy 等第三方 API）
6. 明文机密自动迁移（现在只告警并提示「重新保存即可」，可加一键重写）
