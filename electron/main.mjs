import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCloudIntegration, isCloudUrl } from './cloud.mjs'
import { ensureRuntime, startRuntime, waitForReady } from './runtime-manager.mjs'

let runtimeProcess
let cloud
let localOrigin
let managedLocal = false
let activeMode = 'cloud'
let transition
let quitting = false
let pendingLink
const windows = new Map()

if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11')

async function availablePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(preferred, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function portOrFallback(preferred) {
  try {
    return await availablePort(preferred)
  } catch (error) {
    if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error
    return availablePort()
  }
}

async function localPort(rootDir) {
  const portFile = join(rootDir, 'port')
  let previous
  try {
    previous = Number(await readFile(portFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const preferred = Number.isInteger(previous) && previous >= 1024 && previous <= 65535 ? previous : 0
  const port = await portOrFallback(preferred)
  if (port !== previous) await writeFile(portFile, String(port))
  return port
}

async function loadWindow(win, url, firstLoad) {
  let timeout
  try {
    const painted = firstLoad ? new Promise((resolve) => win.once('ready-to-show', resolve)) : undefined
    await Promise.race([
      Promise.all([win.loadURL(url), painted]),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('A página demorou demais para carregar.')), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function localUrl() {
  const developmentUrl = !app.isPackaged && process.env.THINKIAC_DESKTOP_LOCAL_URL
  if (developmentUrl) {
    const url = new URL(developmentUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
      throw new Error('Use um endereço HTTP de desenvolvimento em 127.0.0.1 com porta explícita.')
    }
    const ready = await waitForReady({ port: Number(url.port), readinessPath: '/__ready' })
    localOrigin = new URL(ready).origin
    return new URL('/view/auth/Login?next=%2Fview%2Fshell%2FIndex', ready).href
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('O runtime local empacotado requer Windows x64.')
  }
  const rootDir = join(app.getPath('userData'), 'local')
  const dataDir = join(rootDir, 'data')
  await mkdir(dataDir, { recursive: true })
  const installed = await ensureRuntime({
    rootDir,
    bundledDir: app.isPackaged ? join(process.resourcesPath, 'runtime-bundle') : undefined,
    onProgress: console.log,
  })
  const port = await localPort(rootDir)
  const mcpPort = process.env.MCP_PORT ? undefined : await portOrFallback(3333)
  managedLocal = true
  runtimeProcess = startRuntime({ directory: installed.directory, runtime: installed.runtime, port, mcpPort, dataDir })
  const child = runtimeProcess
  child.on('error', console.error)
  child.once('exit', () => {
    if (runtimeProcess === child) {
      runtimeProcess = undefined
    }
  })
  const ready = await waitForReady({ port, readinessPath: installed.runtime.readinessPath, child })
  localOrigin = new URL(ready).origin
  return new URL('/view/auth/Login?next=%2Fview%2Fshell%2FIndex', ready).href
}

function createWindow(mode, bounds) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...bounds,
    frame: false,
    show: false,
    roundedCorners: true,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, 'window-preload.cjs'),
      additionalArguments: [`--thinkiac-mode=${mode}`, `--thinkiac-local-origin=${localOrigin ?? ''}`],
      contextIsolation: true,
      sandbox: true,
    },
  })
  if (mode === 'cloud') cloud.instalarInterceptacaoDeOauth(win)
  win.on('close', (event) => {
    if (win !== windows.get(activeMode) || quitting) return
    event.preventDefault()
    if (process.platform === 'darwin') win.hide()
    else app.quit()
  })
  win.once('closed', () => { if (windows.get(mode) === win) windows.delete(mode) })
  return win
}

function updateMenu() {
  const menu = Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { label: 'Window', submenu: [
      {
        label: activeMode === 'cloud' ? 'Mudar para Local' : 'Mudar para Cloud',
        accelerator: 'CmdOrCtrl+Shift+L',
        click: () => { void switchMode() },
      },
      { type: 'separator' },
      { role: 'minimize' },
      { role: 'zoom' },
      { role: 'close' },
    ] },
  ])
  Menu.setApplicationMenu(menu)
}

function createModeSplash(parent) {
  const splash = new BrowserWindow({
    parent,
    modal: Boolean(parent),
    ...(parent?.getBounds() ?? { width: 1200, height: 800 }),
    frame: false,
    show: false,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#111111',
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  splash.on('close', (event) => { if (!quitting) event.preventDefault() })
  splash.once('ready-to-show', () => { if (!splash.isDestroyed()) splash.show() })
  splash.loadFile(join(import.meta.dirname, 'splash.html')).catch(console.error)
  return splash
}

async function changeMode(target, url) {
  const source = windows.get(activeMode)
  let destination = windows.get(target)
  let created = false
  const splash = source && target !== activeMode ? createModeSplash(source) : undefined
  try {
    if (target === 'local' && (!localOrigin || (managedLocal && !runtimeProcess))) {
      destination?.destroy()
      destination = undefined
      url = await localUrl()
    }
    if (quitting) return false
    if (!destination) {
      destination = createWindow(target, source?.getNormalBounds())
      created = true
    }
    const entry = url ?? (target === 'cloud' && created ? cloud.urlBase() : undefined)
    if (entry) await loadWindow(destination, entry, created)
    if (quitting) return false
    if (source && destination !== source) {
      destination.setBounds(source.getNormalBounds())
      if (source.isMaximized()) destination.maximize()
      else if (destination.isMaximized()) destination.unmaximize()
      destination.setAlwaysOnTop(source.isAlwaysOnTop())
    }
    windows.set(target, destination)
    activeMode = target
    updateMenu()
    if (splash && !splash.isDestroyed()) splash.destroy()
    if (source !== destination) source?.hide()
    if (destination.isMinimized()) destination.restore()
    destination.show()
    destination.focus()
    return true
  } catch (error) {
    if (created && !destination.isDestroyed()) destination.destroy()
    if (target === 'local') {
      localOrigin = undefined
      runtimeProcess?.kill()
      runtimeProcess = undefined
    }
    if (splash && !splash.isDestroyed()) splash.destroy()
    if (!quitting) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'ThinkIac',
        message: target === 'local' ? 'O ThinkIac local não conseguiu iniciar.' : 'O ThinkIac Cloud não carregou.',
        detail: error.message,
        buttons: source ? ['OK'] : ['Tentar novamente', 'Abrir Local', 'Sair'],
        cancelId: source ? 0 : 2,
      })
      if (!source && response !== 2) return changeMode(response === 0 ? target : 'local', response === 0 ? url : undefined)
      if (!source) app.quit()
      else source.focus()
    }
    return false
  } finally {
    if (splash && !splash.isDestroyed()) splash.destroy()
  }
}

function switchMode(target = activeMode === 'cloud' ? 'local' : 'cloud') {
  if (target !== 'local' && target !== 'cloud') return false
  if (transition) return false
  if (target === activeMode) return true
  transition = changeMode(target).finally(() => { transition = undefined })
  return transition
}

async function focusCloud(url) {
  while (transition) await transition
  if (quitting) return
  transition = changeMode('cloud', url).finally(() => { transition = undefined })
  await transition
}

function acceptsPage(event) {
  const win = windows.get(activeMode)
  const frame = event.senderFrame
  if (!win || !frame || frame !== win.webContents.mainFrame || event.sender !== win.webContents) return false
  if (activeMode === 'cloud') return isCloudUrl(frame.url)
  try { return new URL(frame.url).origin === localOrigin } catch { return false }
}

function registerWindowControls() {
  ipcMain.handle('thinkiac:switch-mode', (event, target) => acceptsPage(event) && switchMode(target))
  ipcMain.on('win-minimize', (event) => { if (acceptsPage(event)) windows.get(activeMode).minimize() })
  ipcMain.on('win-maximize', (event) => {
    if (!acceptsPage(event)) return
    const win = windows.get(activeMode)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win-close', (event) => { if (acceptsPage(event)) windows.get(activeMode).close() })
  ipcMain.handle('win-get-pin', (event) => acceptsPage(event) && windows.get(activeMode).isAlwaysOnTop())
  ipcMain.handle('win-toggle-pin', (event) => {
    if (!acceptsPage(event)) return false
    const win = windows.get(activeMode)
    const pinned = !win.isAlwaysOnTop()
    win.setAlwaysOnTop(pinned)
    return pinned
  })
}

function receiveLink(url) {
  if (!url) return
  if (cloud) cloud.tratarDeepLink(url)
  else pendingLink = url
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', (_event, argv) => {
    const win = windows.get(activeMode)
    if (win?.isMinimized()) win.restore()
    win?.show()
    win?.focus()
    receiveLink(argv.find((argument) => argument.startsWith('thinkiac://')))
  })
  app.on('activate', () => {
    const win = windows.get(activeMode)
    if (win && !transition) {
      win.show()
      win.focus()
    }
  })
  app.on('open-url', (event, url) => { event.preventDefault(); receiveLink(url) })
  app.on('before-quit', () => {
    quitting = true
    cloud?.stopNtfy()
    runtimeProcess?.kill()
  })
  app.whenReady().then(async () => {
    cloud = createCloudIntegration({ focusCloud: (url) => { void focusCloud(url).catch(console.error) } })
    cloud.registrarProtocolo()
    registerWindowControls()
    updateMenu()
    const link = pendingLink ?? cloud.deepLinkDeArgv(process.argv)
    if (!link || !cloud.tratarDeepLink(link)) {
      transition = changeMode('cloud').finally(() => { transition = undefined })
      await transition
    }
    if (!quitting) cloud.startNtfy()
  }).catch((error) => { console.error(error); app.quit() })
} else {
  app.quit()
}
