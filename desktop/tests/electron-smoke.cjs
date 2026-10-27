const { app, BrowserWindow, dialog } = require('electron');
const { join, resolve } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');

const output = resolve(__dirname, '../../build/desktop-smoke');
// The automation process has no physical presentation surface. Product builds
// keep GPU acceleration; the UI fixture renders off that hardware boundary.
app.disableHardwareAcceleration();
app.setPath('userData', join(output, 'profile'));
app.on('window-all-closed', () => {});
let desktop;
const errors = [];
const screenshots = {};
async function until(action, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await action(); if (value) return value; await delay(200); }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const { startDesktop } = require('../main.cjs');
  desktop = await startDesktop({ data: join(output, 'core'), checkOnStartup: false });
  const { window, page, backend } = desktop;
  page.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const capture = async name => {
    await delay(350);
    try { await writeFile(join(output, name), (await page.webContents.capturePage()).toPNG()); screenshots[name] = 'captured'; }
    catch (error) { screenshots[name] = `unavailable in automation surface: ${error.message}`; }
  };
  await desktop.ready;
  assert.ok(backend.launcher, 'real backend discovered');
  assert.equal(page.webContents.getURL(), backend.launcher);
  await until(() => page.webContents.executeJavaScript('document.body.innerText.includes("进入 Piik") || document.body.innerText.includes("Open Piik")'), 'launcher renders');
  await until(() => page.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('.lr-header-controls > .lr-comic-tip-wrap > button[aria-pressed]')];
    return buttons.length > 0 && buttons.every(button => getComputedStyle(button.parentElement).display === 'none');
  })()`), 'terminal-only launcher diagnostic entry hidden');
  await capture('launcher.png');
  assert.equal(await page.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await page.webContents.executeJavaScript('typeof window.piikDesktop'), 'undefined');
  assert.equal(await window.webContents.executeJavaScript('typeof window.piikDesktop.home'), 'function');
  assert.equal(await window.webContents.executeJavaScript('typeof window.piikDesktop.update'), 'function');
  const digest = require('../runtime.json').sha256;
  let latest = '2.5.0';
  let githubChecks = 0;
  desktop.updates.fetch = async url => String(url).includes('gitee.com/api/') ? Response.json([{
    tag_name: `v${latest}`, prerelease: false,
    body: `${digest}  piik-app-windows-amd64.zip\n<!-- piik-source: ${require('../runtime.json').revision} -->\n`,
    assets: [{ name: 'piik-app-windows-amd64.zip', browser_download_url: `https://gitee.com/TNTcraftHIM/Piik/releases/download/v${latest}/piik-app-windows-amd64.zip` }],
  }]) : (githubChecks++, Response.json({
    tag_name: `v${latest}`, draft: false, prerelease: false, body: 'Update fixture',
    assets: [{ name: 'piik-app-windows-amd64.zip', state: 'uploaded', size: 39269890, digest: `sha256:${digest}`,
      browser_download_url: `https://github.com/TNTcraftHIM/Piik/releases/download/v${latest}/piik-app-windows-amd64.zip` }],
  }));
  await window.webContents.executeJavaScript('window.piikDesktop.updateSource("auto")');
  assert.equal(desktop.updates.state.phase, 'current');
  const beforeDomestic = githubChecks;
  await window.webContents.executeJavaScript('document.getElementById("update-source").value = "gitee"; document.getElementById("update-source").dispatchEvent(new Event("change"))');
  await until(() => desktop.updates.state.updateSource === 'gitee' && desktop.updates.state.phase === 'current', 'domestic-source dropdown');
  assert.equal(githubChecks, beforeDomestic);
  latest = '2.6.0';
  assert.equal((await desktop.updates.check()).phase, 'available');
  await until(() => window.webContents.executeJavaScript('document.getElementById("update").textContent === "有更新"'), 'update button receives state');
  const oldDialog = dialog.showMessageBox;
  let updateDialogs = 0;
  dialog.showMessageBox = async (_parent, options) => {
    assert.equal(options.title, '发现 Piik 更新');
    updateDialogs++;
    return { response: 0, checkboxChecked: false };
  };
  const corePid = backend.child.pid;
  await window.webContents.executeJavaScript('window.piikDesktop.update()');
  assert.equal(updateDialogs, 1);
  assert.equal(desktop.updates.pending, null);
  assert.equal(backend.child.pid, corePid, 'canceling an update leaves the running core intact');
  desktop.updates.publish({ phase: 'error', message: 'Simulated failed download' });
  await window.webContents.executeJavaScript('window.piikDesktop.update()');
  assert.equal(updateDialogs, 2, 'retry clears a previous failure and offers the update again');
  assert.equal(desktop.updates.state.phase, 'available');
  await page.webContents.executeJavaScript('window.open("https://github.com/TNTcraftHIM/Piik/releases/download/v2.6.0/piik-app-windows-amd64.zip", "_blank"); void 0');
  await until(() => updateDialogs === 3, 'original upstream download enters desktop updater');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  dialog.showMessageBox = oldDialog;
  const origin = new URL(backend.launcher).origin;
  const state = await fetch(origin + '/api/client-launcher').then(r => r.json());
  const address = state.lan?.selected || state.lan?.addresses?.[0]?.address;
  assert.ok(address, 'test LAN available');
  // Select Local through the actual production UI and its real launch handler.
  await page.webContents.executeJavaScript(`(() => {
    const radios = [...document.querySelectorAll('input[type=radio]')];
    const local = radios.find(element => element.value === 'local');
    if (local) local.click();
    const select = [...document.querySelectorAll('select')].find(element => [...element.options].some(option => option.value === ${JSON.stringify(address)}));
    if (select) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(address)}); select.dispatchEvent(new Event('change', { bubbles: true })); }
  })()`);
  await delay(300);
  await page.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find(element => /进入 Piik|Open Piik/.test(element.textContent));
    if (!button) throw Error('Launch button missing');
    button.click();
  })()`);
  await until(() => page.webContents.getURL().startsWith('http://127.0.0.1:8787/'), 'local UI navigation');
  await until(() => page.webContents.executeJavaScript('Boolean(document.querySelector("button[aria-label=\\"创建房间\\"],button[aria-label=\\"Create room\\"]"))'), 'room UI renders');
  await page.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find(element => /创建房间|Create room/.test(element.getAttribute('aria-label') || element.textContent));
    button.click();
  })()`);
  await until(() => page.webContents.executeJavaScript('Boolean(document.querySelector(".lr-lcd[role=group]"))'), 'host room created');
  await capture('room.png');
  // A real Piik Host must connect to the released native control service.
  await until(() => page.webContents.executeJavaScript('document.body.innerText.includes("App")'), 'native App control');
  const health = await fetch(`http://127.0.0.1:${backend.endpoint.port}/health`, { headers: { Origin: 'http://127.0.0.1:8787' } }).then(r => r.json());
  // The toolbar runs real IPC, including a navigation with the room fragment.
  await window.webContents.executeJavaScript(`window.piikDesktop.join(${JSON.stringify(backend.launcher)})`);
  await until(() => page.webContents.getURL() === backend.launcher, 'toolbar navigation');
  assert.equal(await window.webContents.executeJavaScript('window.piikDesktop.join("file:///C:/Windows").then(()=>false,()=>true)'), true);
  const originalDialog = dialog.showMessageBox;
  let closeDialogs = 0, choice = { response: 2, checkboxChecked: false }, preference = 0;
  dialog.showMessageBox = async (_parent, options) => {
    if (options.title === '关闭窗口选项') return { response: preference };
    assert.equal(options.title, '关闭 Piik 窗口');
    closeDialogs++;
    return choice;
  };
  await desktop.lifecycle.configure(); // Reset this isolated fixture to Ask.
  assert.ok(desktop.lifecycle.tray && !desktop.lifecycle.tray.isDestroyed());
  const activeURL = page.webContents.getURL();
  window.close();
  await until(() => closeDialogs === 1 && !desktop.lifecycle.pending, 'cancel close');
  assert.equal(window.isVisible(), true);
  choice = { response: 0, checkboxChecked: true };
  window.close();
  await until(() => !window.isVisible() && !desktop.lifecycle.pending, 'hide to tray');
  assert.equal(window.isDestroyed(), false);
  assert.equal(page.webContents.isDestroyed(), false);
  assert.equal(backend.child.pid, corePid);
  assert.equal((await fetch(origin + '/api/client-launcher')).status, 200);
  assert.equal(JSON.parse(await require('node:fs/promises').readFile(join(output, 'desktop-settings.json'), 'utf8')).closeBehavior, 'tray');
  desktop.lifecycle.tray.emit('double-click');
  await until(() => window.isVisible(), 'tray double-click restore');
  assert.equal(page.webContents.getURL(), activeURL);
  window.close();
  await until(() => !window.isVisible(), 'remembered tray behavior');
  assert.equal(closeDialogs, 2, 'remembered choice does not prompt again');
  desktop.lifecycle.show(); // Same path as a second application launch.
  await until(() => window.isVisible(), 'second-instance restore');
  preference = 2;
  await desktop.lifecycle.configure();
  assert.equal(desktop.lifecycle.behavior, 'exit');
  const originalQuit = app.quit;
  let quitRequested = false;
  app.quit = () => { quitRequested = true; void desktop.close(); };
  window.close();
  await until(() => quitRequested && window.isDestroyed(), 'explicit exit after changing preference');
  await desktop.close();
  app.quit = originalQuit;
  dialog.showMessageBox = originalDialog;
  assert.equal(desktop.lifecycle.tray.isDestroyed(), true);
  const { WindowLifecycle } = require('../window-lifecycle.cjs');
  const nextWindow = new BrowserWindow({ show: false });
  const nextLifecycle = new WindowLifecycle({ window: nextWindow, windows: () => [nextWindow], userData: output,
    icon: resolve(__dirname, '../assets/piik.ico'), quit: () => {} });
  await nextLifecycle.initialize();
  assert.equal(nextLifecycle.behavior, 'exit', 'close preference is restored on the next launch');
  nextLifecycle.dispose(); nextWindow.destroy();
  await assert.rejects(fetch(origin + '/api/client-launcher'));
  await assert.rejects(fetch('http://127.0.0.1:8787/'));
  const result = { passed: true, launcher: true, localRoom: true, nativeCapabilities: health.nativeMedia, windowCapture: 'physical acceptance required', screenshots, rendererIsolation: true, updateUI: true, domesticSource: true, updateCancellation: true, upstreamUpdateInterception: true, launcherDiagnosticHidden: true, closeCancellation: true, trayHideRestore: true, closePreferencePersistence: true, ipcNavigation: true, cleanShutdown: true, consoleErrors: errors };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (desktop) {
    console.error('PAGE:', desktop.page.webContents.isDestroyed() ? '(closed)' : await desktop.page.webContents.executeJavaScript('document.body.innerText').catch(() => '(unavailable)'));
    await desktop.close();
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack, consoleErrors: errors }, null, 2)).catch(() => {});
  app.exit(1);
});
