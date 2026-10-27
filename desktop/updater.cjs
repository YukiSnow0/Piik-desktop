const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const { join, resolve, relative, isAbsolute } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Backend } = require('./backend.cjs');
const bundledManifest = require('./runtime.json');

const API = 'https://api.github.com/repos/TNTcraftHIM/Piik/releases/latest';
const MIRROR_API = 'https://gitee.com/api/v5/repos/TNTcraftHIM/Piik/releases';
const ASSET = 'piik-app-windows-amd64.zip';
const MAX_DOWNLOAD = 512 * 1024 * 1024;
const run = promisify(execFile);
const version = value => /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(value || '');

function releaseFromGitHub(value) {
  const parsed = version(value?.tag_name);
  if (!parsed || value.draft || value.prerelease) throw new Error('GitHub 未提供可用的正式发布版。');
  const asset = value.assets?.find(item => item.name === ASSET && item.state === 'uploaded');
  if (!asset) throw new Error('这个正式版尚未发布 Windows x64 App，请稍后重试。');
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('此发布包缺少 GitHub SHA-256 校验值，已停止更新。');
  const tag = value.tag_name;
  const url = `https://github.com/TNTcraftHIM/Piik/releases/download/${tag}/${ASSET}`;
  if (asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD) {
    throw new Error('GitHub 发布包信息不正确。');
  }
  return {
    version: parsed.slice(1).join('.'), tag, url,
    mirrorUrl: `https://gitee.com/TNTcraftHIM/Piik/releases/download/${tag}/${ASSET}`,
    sha256: asset.digest.slice(7).toLowerCase(), size: asset.size,
    source: 'github', notes: String(value.body || '').split('<!-- piik-build-checksums:start -->')[0].slice(0, 12000),
  };
}

function releaseFromGitee(value) {
  const parsed = version(value?.tag_name);
  if (!parsed || value.prerelease !== false || value.draft === true || typeof value.body !== 'string') throw new Error('不是可用的 Gitee 正式版。');
  const source = [...value.body.matchAll(/^<!-- piik-source: ([a-f0-9]{40}) -->\r?$/gm)];
  const checksums = [...value.body.matchAll(/^([a-f0-9]{64})[ \t]+\*?piik-app-windows-amd64\.zip[ \t]*\r?$/gmi)];
  if (source.length !== 1 || checksums.length !== 1) throw new Error('Gitee 发布说明缺少唯一源码标识或 SHA-256 校验值。');
  const tag = value.tag_name;
  const mirrorUrl = `https://gitee.com/TNTcraftHIM/Piik/releases/download/${tag}/${ASSET}`;
  const assets = value.assets?.filter(asset => asset.name === ASSET && asset.browser_download_url === mirrorUrl);
  if (assets?.length !== 1) throw new Error('Gitee 正式版尚无完整的 Windows x64 App。');
  return {
    version: parsed.slice(1).join('.'), tag,
    url: `https://github.com/TNTcraftHIM/Piik/releases/download/${tag}/${ASSET}`, mirrorUrl,
    sha256: checksums[0][1].toLowerCase(), revision: source[0][1], size: null,
    source: 'gitee', notes: value.body.split('<!-- piik-build-checksums:start -->')[0].slice(0, 12000),
  };
}

function newer(candidate, current) {
  const a = version(candidate), b = version(current);
  if (!a || !b) throw new Error('版本号格式不正确。');
  for (let index = 1; index <= 3; index++) {
    if (Number(a[index]) !== Number(b[index])) return Number(a[index]) > Number(b[index]);
  }
  return false;
}
const needsUpdate = (candidate, current) => newer(candidate.version, current.version) ||
  (candidate.version === current.version && candidate.sha256 !== current.sha256);

async function json(path) { return JSON.parse(await fs.readFile(path, 'utf8')); }
async function optionalJson(path) {
  try { return await json(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2)); await fs.rename(temporary, path); }
  finally { await fs.rm(temporary, { force: true }); }
}

function validRecord(value) {
  return value && version(value.version) && /^[a-f0-9]{64}$/.test(value.sha256) &&
    /^[a-f0-9]{40}$/.test(value.revision) && value.id === `${value.version}-${value.sha256.slice(0, 8)}`;
}

async function validateRuntime(directory, expected) {
  for (const name of ['piik-app.exe', 'runtime/native/piik-capture.exe', 'runtime/tunnel/cloudflared.exe', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
    if (!(await fs.stat(join(directory, name))).isFile()) throw new Error('更新包缺少完整的 Piik App 文件。');
  }
  const revision = (await fs.readFile(join(directory, 'REVISION'), 'utf8')).trim();
  if (!/^[a-f0-9]{40}$/.test(revision) || (expected && revision !== expected.revision)) throw new Error('更新包源码版本不匹配。');
  return revision;
}

async function extractArchive(zip, directory) {
  const quote = text => "'" + text.replaceAll("'", "''") + "'";
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(directory)} -Force`],
  { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
}

class UpdateManager extends EventEmitter {
  constructor({ bundledRuntime, userData, manifest = bundledManifest, fetchImpl = globalThis.fetch }) {
    super();
    this.bundledRuntime = bundledRuntime;
    this.userData = userData;
    this.manifest = manifest;
    this.fetch = fetchImpl;
    this.root = join(userData, 'updates');
    this.runtime = bundledRuntime;
    this.current = { version: manifest.version, revision: manifest.revision, sha256: manifest.sha256 };
    this.state = { phase: 'idle', currentVersion: manifest.version };
    this.operation = null;
    this.record = null;
    this.pending = null;
    this.closed = false;
    this.source = 'auto';
    this.controller = new AbortController();
  }

  publish(values) {
    this.state = { ...values, currentVersion: this.current.version, updateSource: this.source };
    if (!this.closed) this.emit('state', this.state);
    return this.state;
  }

  // Every update path is derived from a checked record, never from a remote path.
  local(...parts) {
    const target = resolve(this.root, ...parts), inside = relative(resolve(this.root), target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('无效的更新目录。');
    return target;
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const settings = await optionalJson(this.local('settings.json'));
      if (['auto', 'github', 'gitee'].includes(settings?.source)) this.source = settings.source;
    } catch {}
    let warning;
    try {
      this.record = await optionalJson(this.local('active.json'));
      if (this.record) {
        if (!validRecord(this.record.active) || (this.record.previous !== null && !validRecord(this.record.previous)) || !/^[a-f0-9-]{8}$/.test(this.record.backup)) {
          throw new Error('本地更新记录已损坏。');
        }
        const path = this.local('runtimes', this.record.active.id);
        await validateRuntime(path, this.record.active);
        this.runtime = path;
        this.current = this.record.active;
      }
    } catch (error) {
      if (validRecord(this.record?.active) && (this.record.previous === null || validRecord(this.record.previous)) && /^[a-f0-9]{8}$/.test(this.record.backup)) {
        await this.rollback(error.message);
        warning = this.state.message;
      } else {
        warning = `更新记录无法使用，已使用随程序提供的版本：${error.message}`;
        this.record = null;
      }
    }
    try {
      this.pending = await optionalJson(this.local('pending.json'));
      if (this.pending) {
        if (!validRecord(this.pending)) throw new Error('待安装更新记录不正确。');
        const path = this.local('runtimes', this.pending.id);
        await validateRuntime(path, this.pending);
        if (needsUpdate(this.pending, this.current)) await this.activatePending();
        else { await fs.rm(this.local('pending.json'), { force: true }); this.pending = null; }
      }
    } catch (error) {
      warning = `待安装更新未能应用，仍使用原版本：${error.message}`;
      await fs.rm(this.local('pending.json'), { force: true });
      this.pending = null;
    }
    this.publish({ phase: 'idle', ...(warning ? { message: warning } : {}) });
    return this.runtime;
  }

  async activatePending() {
    const backup = randomUUID().slice(0, 8);
    const snapshot = this.local('backups', backup);
    await fs.mkdir(snapshot, { recursive: true });
    await fs.mkdir(join(this.userData, 'core'), { recursive: true });
    for (const item of await fs.readdir(join(this.userData, 'core'), { withFileTypes: true })) {
      if (item.isFile() && item.name.startsWith('client.json')) await fs.copyFile(join(this.userData, 'core', item.name), join(snapshot, item.name));
    }
    const next = { active: this.pending, previous: this.record?.active || null, backup };
    await atomicJson(this.local('active.json'), next);
    this.record = next;
    this.current = next.active;
    this.runtime = this.local('runtimes', next.active.id);
    this.pending = null;
    // A leftover pending record is harmless: the next boot compares it with the
    // authoritative active version before applying anything.
    await fs.rm(this.local('pending.json'), { force: true }).catch(() => {});
  }

  async rollback(reason) {
    if (!this.record) return false;
    const previous = this.record.previous;
    let path = this.bundledRuntime;
    if (previous) { path = this.local('runtimes', previous.id); await validateRuntime(path, previous); }
    const core = join(this.userData, 'core');
    const snapshot = this.local('backups', this.record.backup);
    for (const item of await fs.readdir(core, { withFileTypes: true })) {
      if (item.isFile() && item.name.startsWith('client.json')) await fs.rm(join(core, item.name));
    }
    for (const name of await fs.readdir(snapshot)) await fs.copyFile(join(snapshot, name), join(core, name));
    if (previous) await atomicJson(this.local('active.json'), { active: previous, previous: null, backup: this.record.backup });
    else await fs.rm(this.local('active.json'), { force: true });
    this.runtime = path;
    this.current = previous || { version: this.manifest.version, revision: this.manifest.revision, sha256: this.manifest.sha256 };
    this.record = previous ? { active: previous, previous: null, backup: this.record.backup } : null;
    this.publish({ phase: 'error', message: `新版启动失败，已恢复 ${this.current.version}：${reason}` });
    return true;
  }

  check() {
    if (this.operation) return this.operation;
    if (this.pending) return Promise.resolve(this.publish({ phase: 'ready', latestVersion: this.pending.version }));
    this.operation = this.checkRelease().finally(() => { this.operation = null; });
    return this.operation;
  }

  async checkRelease() {
    this.publish({ phase: 'checking' });
    const sources = this.source === 'auto' ? ['github', 'gitee'] : [this.source];
    const errors = [];
    for (const source of sources) {
      try {
        const release = await this.readRelease(source);
        this.latest = needsUpdate(release, this.current) ? release : null;
        return this.publish({ phase: this.latest ? 'available' : 'current', latestVersion: release.version, metadataSource: source });
      } catch (error) {
        errors.push(`${source === 'github' ? 'GitHub' : 'Gitee'}：${error.message}`);
        if (this.closed) break;
      }
    }
    return this.publish({ phase: 'error', message: `检查更新失败。${errors.join('；')}` });
  }

  async readRelease(source) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(source === 'github' ? 8000 : 20000)]);
    let latest;
    for (let page = 1; page <= (source === 'github' ? 1 : 10); page++) {
      const url = source === 'github' ? API : `${MIRROR_API}?per_page=100&page=${page}&direction=desc`;
      const response = await this.fetch(url, {
        headers: { Accept: source === 'github' ? 'application/vnd.github+json' : 'application/json',
          ...(source === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}), 'User-Agent': `PiikDesktop/${require('./package.json').version}` },
        cache: 'no-store', credentials: 'omit', signal,
      });
      if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）。`);
      const value = await response.json();
      if (source === 'github') return releaseFromGitHub(value);
      if (!Array.isArray(value) || value.length > 100) throw new Error('发布列表格式不正确。');
      for (const item of value) {
        try {
          const release = releaseFromGitee(item);
          if (!latest || newer(release.version, latest.version)) latest = release;
        } catch {}
      }
      if (value.length < 100) {
        if (!latest) throw new Error('没有包含完整安装包和校验信息的正式版。');
        return latest;
      }
    }
    throw new Error('发布列表过长，无法确认最新版本。');
  }

  async setSource(source) {
    if (!['auto', 'github', 'gitee'].includes(source)) throw new Error('无效的更新源。');
    if (this.operation) throw new Error('请等待当前更新操作结束后再切换更新源。');
    await atomicJson(this.local('settings.json'), { source });
    this.source = source;
    this.latest = null;
    this.publish({ phase: this.pending ? 'ready' : 'idle', ...(this.pending ? { latestVersion: this.pending.version } : {}) });
    return this.check();
  }

  prepare() {
    if (this.operation) return this.operation;
    if (!this.latest) return Promise.reject(new Error('请先检查更新。'));
    if (this.pending) return Promise.resolve(this.state);
    this.operation = this.downloadAndVerify(this.latest).finally(() => { this.operation = null; });
    return this.operation;
  }

  async downloadAndVerify(release) {
    const staging = this.local(`.s-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(staging, { recursive: true });
    const zip = join(staging, 'update.zip');
    let probe;
    try {
      let downloaded = false, lastError;
      const urls = this.source === 'gitee' ? [release.mirrorUrl] : this.source === 'github' ? [release.url]
        : release.source === 'gitee' ? [release.mirrorUrl, release.url] : [release.url, release.mirrorUrl];
      for (const url of urls) {
        if (this.closed) throw new Error('更新已取消。');
        this.publish({ phase: 'downloading', latestVersion: release.version, progress: 0, source: new URL(url).hostname });
        try {
          const response = await this.fetch(url, { credentials: 'omit', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(180000)]) });
          if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）。`);
          const length = Number(response.headers.get('content-length'));
          const expectedSize = release.size || (Number.isSafeInteger(length) && length > 0 ? length : null);
          let received = 0, lastPercent = -1;
          const hash = createHash('sha256');
          const measure = new Transform({ transform: (chunk, _encoding, callback) => {
            received += chunk.length;
            if ((expectedSize && received > expectedSize) || received > MAX_DOWNLOAD) return callback(new Error('下载包大小不符合发布信息。'));
            hash.update(chunk);
            const percent = expectedSize ? Math.floor(received * 100 / expectedSize) : null;
            if (percent !== lastPercent) { lastPercent = percent; this.publish({ phase: 'downloading', latestVersion: release.version, progress: percent, source: new URL(url).hostname }); }
            callback(null, chunk);
          } });
          await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(zip), { signal: this.controller.signal });
          if ((expectedSize && received !== expectedSize) || hash.digest('hex') !== release.sha256) throw new Error('SHA-256 或文件大小校验失败，未安装更新。');
          downloaded = true;
          break;
        } catch (error) { lastError = error; }
      }
      if (!downloaded) throw lastError;
      this.publish({ phase: 'verifying', latestVersion: release.version });
      const extraction = join(staging, 'files');
      await extractArchive(zip, extraction);
      let path = extraction;
      try { await fs.access(join(path, 'piik-app.exe')); }
      catch {
        const entries = await fs.readdir(extraction, { withFileTypes: true });
        const directory = entries.find(item => item.isDirectory());
        if (!directory) throw new Error('发布包结构不正确。');
        path = join(extraction, directory.name);
      }
      const revision = await validateRuntime(path);
      if (release.revision && revision !== release.revision) throw new Error('Gitee 发布的源码标识与安装包不匹配。');
      probe = this.probe = new Backend(path, join(staging, 'probe'));
      const launcher = await probe.start();
      const response = await this.fetch(new URL('/api/client-launcher', launcher), { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]) });
      if (!response.ok) throw new Error('新版 App 启动页不兼容此桌面版。');
      const state = await response.json();
      if (String(state.version).replace(/^v/, '') !== release.version || state.revision !== revision || !Number.isInteger(state.controlPort)) throw new Error('新版 App 的运行版本或接口不匹配。');
      await probe.stop();
      if (this.closed) throw new Error('更新已取消。');
      const record = { version: release.version, revision, sha256: release.sha256, id: `${release.version}-${release.sha256.slice(0, 8)}` };
      const destination = this.local('runtimes', record.id);
      await fs.mkdir(this.local('runtimes'), { recursive: true });
      try { await validateRuntime(destination, record); }
      catch {
        await fs.rm(destination, { recursive: true, force: true });
        await fs.rename(path, destination);
      }
      await atomicJson(this.local('pending.json'), record);
      this.pending = record;
      return this.publish({ phase: 'ready', latestVersion: release.version });
    } catch (error) {
      return this.publish({ phase: 'error', message: `更新未安装，原版本保持可用：${error.message}` });
    } finally {
      if (probe) await probe.stop();
      this.probe = null;
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async close() {
    this.closed = true;
    this.controller.abort();
    if (this.probe) await this.probe.stop();
    if (this.operation) await this.operation.catch(() => {});
  }

  async prune() {
    const retained = new Set([this.record?.active?.id, this.record?.previous?.id, this.pending?.id].filter(Boolean));
    for (const [folder, keep] of [['runtimes', retained], ['backups', new Set([this.record?.backup].filter(Boolean))]]) {
      let entries;
      try { entries = await fs.readdir(this.local(folder), { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const item of entries) {
        if (!item.isDirectory() || keep.has(item.name)) continue;
        if (!(folder === 'runtimes' ? /^\d+\.\d+\.\d+-[a-f0-9]{8}$/ : /^[a-f0-9]{8}$/).test(item.name)) continue;
        await fs.rm(this.local(folder, item.name), { recursive: true, force: true });
      }
    }
  }
}

module.exports = { UpdateManager, releaseFromGitHub, releaseFromGitee, newer, validateRuntime };
