import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRuntime, startRuntime, waitForReady } from './runtime-manager.mjs'

let runtimeProcess
let splash
let starting = false

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function createSplash() {
  const splash = new BrowserWindow({ width: 500, height: 310, resizable: false, frame: false, transparent: false, backgroundColor: '#000000', webPreferences: { preload: join(import.meta.dirname, 'splash-preload.mjs') } })
  splash.loadFile(join(import.meta.dirname, 'splash.html'))
  return splash
}

function showStatus(splash, message) {
  if (!splash.isDestroyed()) splash.webContents.send('runtime-status', message)
}

async function boot() {
  if (starting) return
  starting = true
  try {
    const rootDir = join(app.getPath('userData'), 'local')
    const dataDir = join(rootDir, 'data')
    await mkdir(dataDir, { recursive: true })
    const installed = await ensureRuntime({ rootDir, onProgress: (message) => showStatus(splash, message) })
    showStatus(splash, 'Iniciando servidor local…')
    const port = await availablePort()
    runtimeProcess = startRuntime({ directory: installed.directory, runtime: installed.runtime, port, dataDir })
    const readyUrl = await waitForReady({ port, readinessPath: installed.runtime.readinessPath })
    showStatus(splash, 'Abrindo ThinkIac local…')
    const window = new BrowserWindow({ width: 1280, height: 860, show: false, backgroundColor: '#000000', webPreferences: { contextIsolation: true, sandbox: true } })
    window.once('ready-to-show', () => { window.show(); splash.close() })
    await window.loadURL(readyUrl.replace(installed.runtime.readinessPath, '/'))
  } catch (error) {
    runtimeProcess?.kill()
    runtimeProcess = undefined
    if (!splash.isDestroyed()) splash.webContents.send('runtime-failure', error.message)
    console.error(error)
  } finally {
    starting = false
  }
}

app.whenReady().then(() => {
  splash = createSplash()
  ipcMain.handle('runtime-retry', boot)
  splash.webContents.once('did-finish-load', boot)
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => runtimeProcess?.kill())
