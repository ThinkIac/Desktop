import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('runtime', {
  onStatus: (callback) => ipcRenderer.on('runtime-status', (_event, message) => callback(message)),
  onFailure: (callback) => ipcRenderer.on('runtime-failure', (_event, message) => callback(message)),
  retry: () => ipcRenderer.invoke('runtime-retry')
})
