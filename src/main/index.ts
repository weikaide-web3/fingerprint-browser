import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'node:path'
import { APP_NAME, dbFile, dataDir, profilesRootDir, ensureDir, setDataDir, setResourcesDir, resourcesDir } from './paths'
import { initDatabase, closeDatabase } from './db'
import { registerIpc } from './ipc'
import { initLogging } from './lib/logging'
import { log, logError } from './lib/log'
import { typedSetting } from './settings/defs'
import { startIfEnabled as startApiIfEnabled, stop as stopApi } from './services/api'
import { stopEverything } from './services/browser'
import { cleanupOrphanProcesses } from './browser/crash-recovery'
import { startScheduler, stopScheduler } from './services/scheduler'
import { startMonitor, stopMonitor } from './services/monitor'

app.name = APP_NAME
setDataDir(app.getPath('userData'))
setResourcesDir(app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources'))

/**
 * 单实例锁。
 *
 * 没有它时，第二个实例（打包版 + npm run dev 并存，或双击两次图标）会：
 * 1. 在 cleanupOrphanProcesses() 里把**第一个实例正在用的**全部 Chrome 进程 SIGTERM ——
 *    该清理按「命令行含本 app 的 profiles 根目录」匹配，无法区分进程属于哪个实例；
 * 2. 与第一个实例争抢同一个 app.db（WAL 多写者）与 API 端口 52222。
 * 锁基于 userData 目录，因此 dev 与打包版互斥，正是我们要的语义。
 */
if (!app.requestSingleInstanceLock()) {
  log('app', '已有实例在运行，本实例退出')
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let teardownStarted = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    title: '指纹浏览器',
    show: false,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function createTray(): void {
  const iconPath = join(resourcesDir(), 'trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  // 如果图标不存在，创建一个 16x16 的占位图标
  const trayIcon = icon.isEmpty() ? nativeImage.createEmpty() : icon
  tray = new Tray(trayIcon)
  tray.setToolTip('指纹浏览器')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus() }
        else createWindow()
      }
    },
    { type: 'separator' },
    {
      label: '关闭所有环境',
      click: () => { void stopEverything().catch(() => undefined) }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { app.quit() }
    }
  ])
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.focus()
      else { mainWindow.show(); mainWindow.focus() }
    } else createWindow()
  })
}

void app.whenReady().then(() => {
  ensureDir(dataDir())
  ensureDir(profilesRootDir())
  initLogging()
  initDatabase(dbFile())
  registerIpc()
  createWindow()
  createTray()
  void startApiIfEnabled()
  void cleanupOrphanProcesses()
  startScheduler()
  startMonitor()
  log('app', `${APP_NAME} v${app.getVersion()} 已启动 (electron ${process.versions.electron})`)

  // 用户重复启动时：把已有实例的窗口拉到前台，而不是新起一个进程
  app.on('second-instance', () => {
    log('app', '检测到重复启动，已聚焦现有实例')
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    } else createWindow()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  // 有托盘时不退出，保持后台运行
  if (process.platform !== 'darwin' && !tray) app.quit()
})

/**
 * 退出清理：必须**无条件**执行。
 *
 * 旧实现用 `if (isQuitting) return` 防重入，但托盘「退出」正是先设 isQuitting=true
 * 再 app.quit()，于是这条最常见的退出路径完全跳过了停 API / 停环境 / 关 DB：
 * Chrome 进程残留成孤儿，WAL 未 checkpoint。现在用独立的 teardownStarted 标志防重入。
 *
 * 另外整个 teardown 带超时：stopProfile 内部等 Chrome 响应 SIGTERM，
 * 若某个内核卡死，finally 永不执行 → app 挂死无法退出。
 */
function runTeardown(): void {
  if (teardownStarted) return
  teardownStarted = true
  isQuitting = true

  const closeAll = typedSetting<boolean>('closeAllOnQuit', true)
  stopScheduler()
  stopMonitor()

  const finished = stopApi()
    .catch((e) => logError('app', '关闭自动化 API 失败', e))
    .then(() => (closeAll ? stopEverything().catch((e) => logError('app', '关闭环境失败', e)) : undefined))
    .catch((e) => logError('app', '退出清理异常', e))
    .then(() => {
      tray?.destroy()
      closeDatabase()
    })

  // 超时兜底：无论清理是否走完，都必须让进程退出，避免挂死
  const guard = setTimeout(() => {
    logError('app', '退出清理超时（10s），强制退出')
    app.exit(0)
  }, 10_000)
  guard.unref?.()

  void finished.then(() => app.exit(0))
}

app.on('before-quit', (event) => {
  // 第一次 before-quit：拦住默认退出，先跑完异步清理，清理里再 app.exit(0)
  if (!teardownStarted) {
    event.preventDefault()
    runTeardown()
  }
})

process.on('uncaughtException', (e) => logError('app', 'uncaughtException', e))
process.on('unhandledRejection', (e) => logError('app', 'unhandledRejection', e))
