const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piikDesktop', {
  home: () => ipcRenderer.invoke('desktop:home'),
  back: () => ipcRenderer.invoke('desktop:back'),
  reload: () => ipcRenderer.invoke('desktop:reload'),
  join: value => ipcRenderer.invoke('desktop:join', value),
  restart: () => ipcRenderer.invoke('desktop:restart'),
  certificate: () => ipcRenderer.invoke('desktop:certificate'),
  update: () => ipcRenderer.invoke('desktop:update'),
  updateSource: source => ipcRenderer.invoke('desktop:update-source', source),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:state', listener);
    return () => ipcRenderer.removeListener('desktop:state', listener);
  },
  ready: () => ipcRenderer.invoke('desktop:ready'),
});
