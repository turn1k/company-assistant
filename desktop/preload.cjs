const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('companySetup', { configure: url => ipcRenderer.invoke('configure-server', url) });
