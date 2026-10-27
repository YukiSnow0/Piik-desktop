const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const { join } = require('node:path');
const { mkdir } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

// The released core owns rooms, capture and its children. The desktop owner only
// starts that core, discovers its resident launcher, and requests ordered exit.
class Backend extends EventEmitter {
  constructor(runtime, data) {
    super();
    this.runtime = runtime;
    this.data = data;
    this.child = null;
    this.exited = null;
    this.stopping = false;
    this.launcher = null;
    this.certificate = '';
  }

  async start() {
    if (this.child) throw new Error('Piik 服务已在运行。');
    await mkdir(this.data, { recursive: true });
    if (this.stopping) throw new Error('Piik 服务启动已取消。');
    // Machine mode otherwise starts a Local room immediately. Opening our own
    // loopback Site keeps the original launcher resident and waits for selection.
    // This grants no third-party Site access and performs no network request.
    const child = this.child = spawn(join(this.runtime, 'piik-app.exe'), [
      '--site', 'http://127.0.0.1:8787', '--config', join(this.data, 'client.json'),
    ], {
      cwd: this.runtime,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PIIK_CLIENT_GATE_NO_BROWSER: 'true', PIIK_LOG_DIR: join(this.data, 'logs') },
    });
    let endpoint, startupError, stderr = '';
    child.stdin.on('error', () => {});
    this.exited = new Promise(resolve => {
      child.once('error', error => { startupError = error; resolve(); });
      child.once('exit', code => {
        if (!this.stopping) this.emit('stopped', code);
        resolve();
      });
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line.startsWith('{')) {
        try {
          const value = JSON.parse(line);
          if (new URL(value.url).hostname === '127.0.0.1' && Number.isInteger(value.port) &&
              new URL(value.url).port === String(value.port)) endpoint = value;
        } catch {}
      }
      if (line.startsWith('LAN certificate SHA-256: ')) {
        this.certificate = line.slice('LAN certificate SHA-256: '.length).trim();
        this.emit('certificate', this.certificate);
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !this.stopping) {
      if (startupError) throw new Error(`无法启动 Piik 服务：${startupError.message}`);
      if (child.exitCode !== null) throw new Error(`Piik 服务启动失败。${stderr.trim()}`);
      if (endpoint) {
        try {
          const response = await fetch(`http://127.0.0.1:${endpoint.port}/connect-discovery`, {
            headers: { Origin: 'http://127.0.0.1:8787' }, signal: AbortSignal.timeout(1200),
          });
          if (response.ok) {
            const value = await response.json();
            const url = new URL(value.connectURL);
            if (value.instanceToken === endpoint.instanceToken && url.protocol === 'http:' &&
                url.hostname === '127.0.0.1' && url.pathname === '/client') {
              this.launcher = url.href;
              this.endpoint = endpoint;
              return this.launcher;
            }
          }
        } catch {}
      }
      await delay(150);
    }
    throw new Error('Piik 服务未能及时启动，请关闭其他 Piik 实例后重试。');
  }

  async stop() {
    if (this.stopping) return this.exited;
    this.stopping = true;
    if (!this.child) return;
    const child = this.child;
    if (child.exitCode === null && child.pid) {
      child.stdin.end('\n');
      const finished = await Promise.race([this.exited.then(() => true), delay(8000, undefined, { ref: false }).then(() => false)]);
      if (!finished) {
        // Retire only the process tree acquired by this desktop instance.
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        await new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); });
      }
    }
    await this.exited;
  }
}

function parseInvite(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请粘贴完整的 HTTP 或 HTTPS Piik 邀请链接。');
  }
  // LAN invitations can use HTTP on older sites; the page retains its normal
  // secure-context requirements for microphones and capture.
  return url.href;
}

module.exports = { Backend, parseInvite };
