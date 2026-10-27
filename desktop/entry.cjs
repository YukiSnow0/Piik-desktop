const { app, dialog } = require('electron');
const { startDesktop } = require('./main.cjs');

// Portable data stays beside the executable, isolated from the browser and the
// official App. The development/smoke launcher supplies an isolated directory.
if (process.env.PIIK_DESKTOP_DATA) app.setPath('userData', process.env.PIIK_DESKTOP_DATA);
else if (app.isPackaged) app.setPath('userData', require('node:path').join(require('node:path').dirname(process.execPath), 'Piik-Data'));
app.setAppUserModelId('community.piik.desktop');
let desktop, exiting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (desktop) desktop.lifecycle.show(); });
  app.on('before-quit', event => {
    if (!desktop || exiting) return;
    event.preventDefault();
    exiting = true;
    void desktop.close().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => { desktop = await startDesktop(); }).catch(error => {
    dialog.showErrorBox('Piik 桌面版无法启动', error.message);
    app.quit();
  });
}
