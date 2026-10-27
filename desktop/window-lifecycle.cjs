const { Tray, Menu, dialog } = require('electron');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const choices = ['ask', 'tray', 'exit'];
const labels = { ask: '每次询问', tray: '隐藏到托盘', exit: '退出程序' };

// Hiding retains every room/capture resource. Only the application's explicit
// quit path disposes this owner and lets the backend retire.
class WindowLifecycle {
  constructor({ window, windows, userData, icon, quit }) {
    this.window = window;
    this.windows = windows;
    this.settings = join(userData, 'desktop-settings.json');
    this.icon = icon;
    this.quitApp = quit;
    this.behavior = 'ask';
    this.hiddenWindows = [];
    this.disposed = false;
    this.pending = null;
    this.tray = null;
    this.closeHandler = event => {
      if (this.disposed) return;
      event.preventDefault();
      void this.requestClose();
    };
  }

  async initialize() {
    try {
      const settings = JSON.parse(await fs.readFile(this.settings, 'utf8'));
      if (choices.includes(settings.closeBehavior)) this.behavior = settings.closeBehavior;
    } catch {}
    try {
      this.tray = new Tray(this.icon);
      this.tray.setToolTip('Piik 桌面版');
      this.tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => this.show() },
        { label: '关闭窗口选项…', click: () => { void this.configure(); } },
        { type: 'separator' },
        { label: '退出 Piik', click: () => this.quitApp() },
      ]));
      this.tray.on('click', () => this.show());
      this.tray.on('double-click', () => this.show());
    } catch { this.tray = null; }
    this.window.on('close', this.closeHandler);
  }

  async save(behavior) {
    const temporary = `${this.settings}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ closeBehavior: behavior }, null, 2));
      await fs.rename(temporary, this.settings);
      this.behavior = behavior;
    } finally { await fs.rm(temporary, { force: true }); }
  }

  show() {
    if (this.disposed || this.window.isDestroyed()) return;
    for (const window of this.hiddenWindows) {
      if (!window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); }
    }
    this.hiddenWindows = [];
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  hide() {
    if (this.disposed) return;
    if (!this.tray || this.tray.isDestroyed()) throw new Error('系统托盘暂不可用，窗口保持打开。');
    this.hiddenWindows = this.windows().filter(window => !window.isDestroyed() && window.isVisible());
    for (const window of this.hiddenWindows) window.hide();
  }

  requestClose() {
    if (this.pending || this.disposed) return this.pending;
    this.pending = (async () => {
      try {
        let action = this.behavior;
        if (action === 'ask') {
          const result = await dialog.showMessageBox(this.window, {
            type: 'question', title: '关闭 Piik 窗口', message: '关闭窗口后要怎么做？',
            detail: '隐藏到托盘：保留房间、分享和语音。\n退出程序：结束本机房间和正在进行的分享。',
            buttons: ['隐藏到托盘', '退出程序', '取消'], defaultId: 0, cancelId: 2,
            checkboxLabel: '记住我的选择，可在「窗口 → 关闭窗口选项」修改', checkboxChecked: false,
          });
          if (this.disposed || result.response === 2) return;
          action = result.response === 0 ? 'tray' : 'exit';
          if (result.checkboxChecked) await this.save(action);
        }
        if (this.disposed) return;
        if (action === 'tray') this.hide();
        else this.quitApp();
      } catch (error) {
        if (!this.disposed) await dialog.showMessageBox(this.window, { type: 'error', title: '无法关闭窗口', message: error.message });
      }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  async configure() {
    if (this.disposed || this.pending) return;
    this.show();
    this.pending = (async () => {
      try {
        const result = await dialog.showMessageBox(this.window, {
          type: 'question', title: '关闭窗口选项', message: `当前设置：${labels[this.behavior]}`,
          detail: '选择点击窗口关闭按钮时的行为。「退出 Piik」菜单始终会完整退出。',
          buttons: ['每次询问', '隐藏到托盘', '退出程序', '取消'], defaultId: choices.indexOf(this.behavior), cancelId: 3,
        });
        if (!this.disposed && result.response < 3) await this.save(choices[result.response]);
      } catch (error) {
        if (!this.disposed) await dialog.showMessageBox(this.window, { type: 'error', title: '无法保存窗口设置', message: error.message });
      }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.window.removeListener('close', this.closeHandler);
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.hiddenWindows = [];
  }
}

module.exports = { WindowLifecycle };
