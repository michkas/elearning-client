const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voucherApp', {
  version: '1.0.0',
  statusBar: {
    toggleTargetPanel: () => ipcRenderer.send('status-bar:toggle-target-panel'),
    requestState: () => ipcRenderer.send('status-bar:request-state'),
    onStateChanged: (callback) => {
      ipcRenderer.on('status-bar:state', (_event, state) => callback(state));
    }
  }
});