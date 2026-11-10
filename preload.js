const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voidBrowser', {
  getFormats: (url) => ipcRenderer.invoke('get-formats', url),
  downloadWithFormat: (data) => ipcRenderer.invoke('download-with-format', data),
  downloadVideo: (url) => ipcRenderer.invoke('download-video', url),
  getHistory: () => ipcRenderer.invoke('get-history'),
  onProgress: (cb) => ipcRenderer.on('download-progress', (e, p) => cb(p))
});