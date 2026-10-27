const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capturePicker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  select: (id, audio) => ipcRenderer.send('picker:select', id, audio === true),
});
