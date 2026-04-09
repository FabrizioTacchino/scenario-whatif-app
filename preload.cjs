/**
 * preload.cjs — Espone API sicure al renderer tramite contextBridge.
 * Il renderer non ha accesso diretto a Node.js (nodeIntegration: false).
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
    activate:  (key) => ipcRenderer.invoke('license:activate', key),
    getStored: ()    => ipcRenderer.invoke('license:getStored'),
    clear:     ()    => ipcRenderer.invoke('license:clear'),
    getInfo:   ()    => ipcRenderer.invoke('license:getInfo'),
});

contextBridge.exposeInMainWorld('electronAPI', {
    openExternal:  (url)    => ipcRenderer.invoke('shell:openExternal', url),
    getVersion:    ()       => ipcRenderer.invoke('app:getVersion'),
    setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
    getZoomFactor: ()       => webFrame.getZoomFactor(),
    focusWindow:   ()       => ipcRenderer.invoke('window:focus'),
});

contextBridge.exposeInMainWorld('updaterAPI', {
    onStart:    (cb) => ipcRenderer.on('updater:start',    (_, version) => cb(version)),
    onProgress: (cb) => ipcRenderer.on('updater:progress', (_, percent) => cb(percent)),
    onReady:    (cb) => ipcRenderer.on('updater:ready',    ()           => cb()),
    onError:    (cb) => ipcRenderer.on('updater:error',    (_, msg)     => cb(msg)),
    install:    ()   => ipcRenderer.invoke('updater:install'),
});
