const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voucherSettings', {
  getConfig: () => ipcRenderer.invoke('settings:get-config'),
  saveConfig: (updates) => ipcRenderer.invoke('settings:save-config', updates),
  captureTargetUrl: () => ipcRenderer.invoke('settings:capture-target-url'),
  navigateToTarget: () => ipcRenderer.invoke('settings:navigate-to-target'),
  restartAutomation: () => ipcRenderer.invoke('settings:restart-automation'),
  onConfigUpdated: (callback) => {
    ipcRenderer.on('settings:config-updated', (_event, config) => callback(config));
  }
});