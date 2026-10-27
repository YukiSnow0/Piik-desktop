const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, session, desktopCapturer, net } = require('electron');
const { join, dirname } = require('node:path');
const { Backend, parseInvite } = require('./backend.cjs');
const { UpdateManager } = require('./updater.cjs');
const { WindowLifecycle } = require('./window-lifecycle.cjs');
const desktopVersion = require('./package.json').version;

async function startDesktop({ runtime, data, checkOnStartup = true } = {}) {
  const coreData = data || join(app.getPath('userData'), 'core');
  const updates = new UpdateManager({
    bundledRuntime: runtime || (app.isPackaged ? join(process.resourcesPath, 'piik') : join(__dirname, '../build/desktop-engine/piik')),
    userData: dirname(coreData), fetchImpl: net.fetch.bind(net),
  });
  await updates.initialize();
  let backend = new Backend(updates.runtime, coreData);
  const window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 860, minHeight: 620,
    title: 'Piik 桌面版', backgroundColor: '#f3f5f8', icon: join(__dirname, 'assets/piik.ico'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    show: false,
  });
  const mediaSession = session.fromPartition('persist:piik-rooms');
  const page = new WebContentsView({ webPreferences: {
    session: mediaSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
    backgroundThrottling: false,
  } });
  let phase = 'starting', error = '', showPage = false, closing = false, shutdown, fullscreen = false;
  let certificate = '', chooser = null, updateTimer;
  const trustedCertificates = new Set();
  const popups = new Set();
  const lifecycle = new WindowLifecycle({
    window, windows: () => [window, ...popups], userData: dirname(coreData),
    icon: join(__dirname, 'assets/piik.ico'), quit: () => app.quit(),
  });
  await lifecycle.initialize();
  const trusted = contents => contents === page.webContents || [...popups].some(popup => popup.webContents === contents);
  const sendState = () => {
    if (window.isDestroyed()) return;
    window.webContents.send('desktop:state', { phase, error, showPage, certificate, update: updates.state, canGoBack: !page.webContents.isDestroyed() && page.webContents.navigationHistory.canGoBack() });
  };
  updates.on('state', sendState);
  async function offerRestart() {
    if (closing || !window.isVisible()) return;
    const result = await dialog.showMessageBox(window, {
      type: 'info', title: 'Piik 更新已准备好', message: `Piik ${updates.pending.version} 已下载并验证`,
      detail: '重启会结束本机房间、分享和语音。选择稍后可继续使用，下次启动会应用更新。',
      buttons: ['稍后', '重启并更新'], defaultId: 0, cancelId: 0,
    });
    if (result.response === 1 && !closing) { app.relaunch(); app.quit(); }
  }
  let updateDialog = false;
  async function updateApp() {
    if (updateDialog || closing || updates.operation) return;
    updateDialog = true;
    try {
      if (updates.pending) return await offerRestart();
      if (!updates.latest || updates.state.phase === 'error') await updates.check();
      if (closing) return;
      if (updates.state.phase === 'error') throw new Error(updates.state.message);
      if (!updates.latest) {
        await dialog.showMessageBox(window, { type: 'info', title: '检查更新', message: `Piik ${updates.current.version} 已是最新正式版`, detail: `桌面版 ${desktopVersion}` });
        return;
      }
      const release = updates.latest;
      const chinese = release.notes.split(/###\s*中文/)[1] || release.notes;
      const notes = chinese.replace(/[#*`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim().slice(0, 1800);
      const result = await dialog.showMessageBox(window, {
        type: 'info', title: '发现 Piik 更新', message: `Piik ${updates.current.version} → ${release.version}`,
        detail: `${release.version === updates.current.version ? '这是同版本的新构建。\n' : ''}将更新 Piik 界面、房间服务与原生采集组件。下载期间可以继续使用，重启时生效。\n\n${notes}`,
        buttons: ['稍后', '下载更新'], defaultId: 1, cancelId: 0,
      });
      if (result.response !== 1 || closing) return;
      const state = await updates.prepare();
      if (closing) return;
      if (state.phase !== 'ready') throw new Error(state.message);
      await offerRestart();
    } catch (error) {
      if (!closing) await dialog.showMessageBox(window, { type: 'error', title: '更新未完成', message: error.message, detail: '当前版本仍可继续使用。可以稍后点击「更新」重试。' });
    } finally { updateDialog = false; }
  }
  const upstreamPackage = value => /^https:\/\/(github|gitee)\.com\/TNTcraftHIM\/Piik\/releases\/download\/v?\d+\.\d+\.\d+\/piik-app-windows-amd64\.zip$/.test(value);
  const downloadHandler = (event, item) => {
    if (item.getURLChain().some(upstreamPackage)) { event.preventDefault(); void updateApp(); }
  };
  mediaSession.on('will-download', downloadHandler);
  const resize = () => {
    const [width, height] = window.getContentSize();
    const top = fullscreen ? 0 : 68;
    page.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  };
  async function navigate(value) {
    const target = parseInvite(value);
    await page.webContents.loadURL(target);
    if (closing) return;
    if (!showPage) window.contentView.addChildView(page);
    showPage = true;
    resize();
    sendState();
  }
  function pageError(message) {
    error = message;
    showPage = false;
    window.contentView.removeChildView(page);
    phase = 'error';
    sendState();
  }
  const handlers = {
    'desktop:ready': () => sendState(),
    'desktop:home': () => backend.launcher ? navigate(backend.launcher) : undefined,
    'desktop:join': async value => {
      if (typeof value !== 'string' || value.length > 16384) throw new Error('邀请链接格式不正确。');
      await navigate(value);
    },
    'desktop:back': () => { if (page.webContents.navigationHistory.canGoBack()) page.webContents.navigationHistory.goBack(); },
    'desktop:reload': () => page.webContents.reload(),
    'desktop:certificate': () => dialog.showMessageBox(window, {
      type: 'info', title: '本地房间证书', message: certificate ? '请让朋友核对这个 SHA-256 指纹' : '本地房间尚未启动',
      detail: certificate || '使用 UU 时，先在本地房间选择 UU 的虚拟地址并启动。',
    }),
    'desktop:restart': () => app.relaunch() || app.quit(),
    'desktop:update': updateApp,
    'desktop:update-source': source => updates.setSource(source),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的窗口请求。');
      return handler(...args);
    });
  }

  function configureContents(contents) {
    contents.on('dom-ready', () => {
      if (!backend.launcher || contents.isDestroyed()) return;
      const address = new URL(contents.getURL());
      if (address.origin !== new URL(backend.launcher).origin || address.pathname !== '/client') return;
      // The launcher's pressed chip controls terminal diagnostics. Keep browser
      // report tools on room pages; hide only this desktop-inapplicable entry.
      void contents.insertCSS('body:has(main.lr-client-launch) .lr-header-controls > .lr-comic-tip-wrap:has(> button[aria-pressed]) { display: none !important; }').catch(() => {});
    });
    contents.on('will-navigate', (event, url) => {
      if (upstreamPackage(url)) { event.preventDefault(); void updateApp(); return; }
      try { parseInvite(url); } catch { event.preventDefault(); }
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (upstreamPackage(url)) { void updateApp(); return { action: 'deny' }; }
      if (url === 'about:blank') return { action: 'deny' };
      try { parseInvite(url); } catch { return { action: 'deny' }; }
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 1080, height: 780, minWidth: 640, title: 'Piik', autoHideMenuBar: true,
        webPreferences: { session: mediaSession, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      } };
    });
    contents.on('did-create-window', popup => {
      popups.add(popup);
      configureContents(popup.webContents);
      popup.on('closed', () => popups.delete(popup));
    });
    contents.on('enter-html-full-screen', () => { fullscreen = true; window.setFullScreen(true); resize(); });
    contents.on('leave-html-full-screen', () => { fullscreen = false; window.setFullScreen(false); resize(); });
  }
  configureContents(page.webContents);
  page.webContents.on('did-navigate', sendState);
  page.webContents.on('did-navigate-in-page', sendState);
  page.webContents.on('render-process-gone', () => pageError('房间窗口意外关闭。请重新启动桌面版。'));
  page.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(window, { type: 'question', message: '离开当前房间？', detail: '当前观看、分享或语音可能会中断。', buttons: ['留在房间', '离开'], defaultId: 0, cancelId: 0 });
    if (response === 1) event.preventDefault();
  });

  mediaSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!contents || !trusted(contents)) return false;
    try { if (new URL(origin).origin !== new URL(contents.getURL()).origin) return false; } catch { return false; }
    return ['media', 'display-capture', 'fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'local-network-access', 'loopback-network'].includes(permission);
  });
  mediaSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (!trusted(contents) || (details.requestingUrl && new URL(details.requestingUrl).origin !== new URL(contents.getURL()).origin)) return callback(false);
    // The display picker remains the consent boundary; denying it does not save
    // a permanent refusal, so the user can open it again after cancellation.
    if (['display-capture', 'fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'local-network-access', 'loopback-network'].includes(permission)) return callback(true);
    if (permission === 'media') {
      const devices = details.mediaTypes?.map(type => type === 'audio' ? '麦克风' : '摄像头').join('、') || '麦克风或摄像头';
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: '设备权限', message: `允许此房间使用${devices}？`,
        detail: new URL(contents.getURL()).origin, buttons: ['不允许', '允许'], defaultId: 0, cancelId: 0,
      });
      return callback(result.response === 1 && !contents.isDestroyed());
    }
    callback(false);
  });
  const certificateHandler = async (event, contents, url, code, cert, callback) => {
    if (!trusted(contents)) return callback(false);
    event.preventDefault();
    const key = `${new URL(url).origin}:${cert.fingerprint256}`;
    if (trustedCertificates.has(key)) return callback(true);
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: '核对本地房间证书', message: '这个房间使用自签名或未受信任的证书',
      detail: `${new URL(url).origin}\n\nSHA-256：${cert.fingerprint256}\n\n请先与房主核对指纹。仅在本次运行中信任此证书。`,
      buttons: ['取消', '已核对，继续'], defaultId: 0, cancelId: 0,
    });
    if (result.response === 1) trustedCertificates.add(key);
    callback(result.response === 1 && !closing);
  };
  app.on('certificate-error', certificateHandler);

  mediaSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.frame || request.frame !== page.webContents.mainFrame || chooser) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
      if (closing) return callback({});
      chooser = new BrowserWindow({
        parent: window, modal: true, width: 860, height: 660, minWidth: 640, title: '选择分享内容', autoHideMenuBar: true,
        webPreferences: { preload: join(__dirname, 'picker-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      const picker = chooser;
      const read = event => {
        if (event.sender !== picker.webContents) return [];
        return sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
      };
      let selected = false;
      const select = (event, id, audio) => {
        if (event.sender !== picker.webContents || selected) return;
        const source = sources.find(item => item.id === id);
        if (!source) return;
        selected = true;
        callback({ video: source, ...(audio ? { audio: 'loopback' } : {}) });
        picker.close();
      };
      ipcMain.handle('picker:sources', read);
      ipcMain.on('picker:select', select);
      picker.on('closed', () => {
        ipcMain.removeHandler('picker:sources');
        ipcMain.removeListener('picker:select', select);
        chooser = null;
        if (!selected) callback({});
      });
      await picker.loadFile(join(__dirname, 'picker.html'));
    } catch { if (chooser) chooser.close(); else callback({}); }
  });

  backend.on('stopped', () => { if (!closing) pageError('Piik 本地服务已停止，请重新启动。'); });
  backend.on('certificate', value => { certificate = value; sendState(); });
  window.on('resize', resize);
  window.on('closed', () => { void close(); });
  async function close() {
    if (shutdown) return shutdown;
    closing = true;
    lifecycle.dispose();
    shutdown = (async () => {
      clearTimeout(updateTimer);
      if (chooser) chooser.destroy();
      for (const popup of popups) popup.destroy();
      if (!page.webContents.isDestroyed()) page.webContents.close();
      for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
      app.removeListener('certificate-error', certificateHandler);
      mediaSession.removeListener('will-download', downloadHandler);
      await Promise.all([backend.stop(), updates.close()]);
      if (!window.isDestroyed()) window.destroy();
    })();
    return shutdown;
  }
  const menu = Menu.buildFromTemplate([
    { label: '房间', submenu: [
      { label: '房间启动页', accelerator: 'CmdOrCtrl+Home', click: () => { if (backend.launcher) void navigate(backend.launcher).catch(() => {}); } },
      { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => page.webContents.reload() },
      { type: 'separator' },
      { label: '退出 Piik', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ] },
    { label: '视图', submenu: [
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { label: '全屏窗口', accelerator: 'F11', click: () => window.setFullScreen(!window.isFullScreen()) },
    ] },
    { label: '窗口', submenu: [
      { label: '关闭窗口选项…', click: () => { void lifecycle.configure(); } },
    ] },
    { label: '帮助', submenu: [
      { label: '检查 Piik 更新', click: () => { void updateApp(); } },
      { label: '关于桌面版', click: () => dialog.showMessageBox(window, { type: 'info', message: `Piik 桌面版 ${desktopVersion}`, detail: `Piik 内核 ${updates.current.version}\n支持 GitHub 与 Gitee 正式发布版更新。\n\nUU 联机：选择本地房间和 UU 虚拟地址。\n整屏声音：可在 Piik 声音设置中排除语音软件。\n\n此构建不是 Piik 官方发布。` }) },
    ] },
  ]);
  window.setMenu(menu);
  window.setAutoHideMenuBar(true);
  try { await window.loadFile(join(__dirname, 'index.html')); }
  catch (failure) { await close(); throw failure; }
  window.show();
  const ready = (async () => {
    try {
      let launcher;
      try { launcher = await backend.start(); }
      catch (failure) {
        await backend.stop();
        if (closing || !await updates.rollback(failure.message)) throw failure;
        backend = new Backend(updates.runtime, coreData);
        backend.on('stopped', () => { if (!closing) pageError('Piik 本地服务已停止，请重新启动。'); });
        backend.on('certificate', value => { certificate = value; sendState(); });
        launcher = await backend.start();
      }
      if (closing) return;
      await navigate(launcher); phase = 'ready'; sendState();
      await updates.prune().catch(() => {});
      if (checkOnStartup) updateTimer = setTimeout(() => { if (!closing) void updates.check(); }, 8000);
    }
    catch (failure) { if (!closing) { await backend.stop(); pageError(failure.message); } }
  })();
  return { window, page, get backend() { return backend; }, updates, lifecycle, ready, close };
}

module.exports = { startDesktop };
