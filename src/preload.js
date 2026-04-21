const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('voucherApp', {
  version: '1.0.0'
});