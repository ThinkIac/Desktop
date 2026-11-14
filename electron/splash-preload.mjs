import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('runtime', { onStatus: (callback) => ipcRenderer.on('runtime-status', (_event, message) => callback(message)) })
