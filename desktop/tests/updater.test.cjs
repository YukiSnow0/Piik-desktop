const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve, join } = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { UpdateManager, releaseFromGitHub, releaseFromGitee, newer } = require('../updater.cjs');
const { Backend } = require('../backend.cjs');
const manifest = require('../runtime.json');
const runtime = resolve(__dirname, '../../build/desktop-engine/piik');
const archive = resolve(__dirname, '../../build/desktop-engine/upstream.zip');

const release = size => ({
  tag_name: 'v2.5.0', draft: false, prerelease: false, body: 'Official release notes',
  assets: [{ name: 'piik-app-windows-amd64.zip', state: 'uploaded', browser_download_url: manifest.url,
    size, digest: `sha256:${manifest.sha256}` }],
});
const mirror = (tag = 'v2.5.0') => ({
  tag_name: tag, prerelease: false,
  body: `Release notes\n${manifest.sha256}  piik-app-windows-amd64.zip\n<!-- piik-source: ${manifest.revision} -->\n`,
  assets: [{ name: 'piik-app-windows-amd64.zip', browser_download_url: `https://gitee.com/TNTcraftHIM/Piik/releases/download/${tag}/piik-app-windows-amd64.zip` }],
});

async function directory(t) {
  const path = resolve(__dirname, '../../build/desktop-update-tests', randomUUID().slice(0, 8));
  await fs.mkdir(path, { recursive: true });
  return path;
}

test('only complete stable GitHub Windows releases with publisher digests are accepted', () => {
  assert.equal(releaseFromGitHub(release(100)).version, '2.5.0');
  for (const change of [{ prerelease: true }, { draft: true }, { tag_name: 'v2.6.0-beta.1' }, { assets: [] }]) {
    assert.throws(() => releaseFromGitHub({ ...release(100), ...change }));
  }
  for (const change of [{ digest: null }, { browser_download_url: 'https://other.example/installer.zip' }, { size: 1e12 }]) {
    const value = release(100); Object.assign(value.assets[0], change);
    assert.throws(() => releaseFromGitHub(value));
  }
  assert.equal(newer('2.10.0', '2.9.9'), true);
  assert.equal(newer('2.5.0', '2.5.0'), false);
  assert.equal(newer('2.4.9', '2.5.0'), false);
});

test('current release and GitHub failure preserve the running bundled runtime', async t => {
  const userData = await directory(t);
  let fail = false;
  const manager = new UpdateManager({ bundledRuntime: runtime, userData, fetchImpl: async () => fail
    ? new Response('', { status: 403 }) : Response.json(release(100)) });
  t.after(() => manager.close());
  await manager.initialize();
  assert.equal((await manager.check()).phase, 'current');
  assert.equal(manager.runtime, runtime);
  fail = true;
  assert.equal((await manager.check()).phase, 'error');
  assert.equal(manager.runtime, runtime);
  await assert.rejects(fs.access(join(userData, 'updates/active.json')));
});

test('Gitee uses the publisher checksum and upstream source marker', () => {
  assert.equal(releaseFromGitee(mirror()).sha256, manifest.sha256);
  assert.equal(releaseFromGitee(mirror()).revision, manifest.revision);
  for (const value of [
    { ...mirror(), prerelease: true }, { ...mirror(), body: 'No checksums' },
    { ...mirror(), body: mirror().body + mirror().body }, { ...mirror(), assets: [] },
  ]) assert.throws(() => releaseFromGitee(value));
});

test('automatic metadata fallback and an independently selected domestic source', async t => {
  const userData = await directory(t);
  let githubRequests = 0, giteeRequests = 0;
  const fetchImpl = async url => {
    if (String(url).includes('api.github.com')) { githubRequests++; throw new Error('GitHub unavailable'); }
    assert.match(String(url), /^https:\/\/gitee.com\/api\/v5\/repos\/TNTcraftHIM\/Piik\/releases\?/);
    giteeRequests++;
    return Response.json([mirror('v2.4.0'), mirror()]);
  };
  const manager = new UpdateManager({ bundledRuntime: runtime, userData, fetchImpl });
  t.after(() => manager.close());
  await manager.initialize();
  assert.equal((await manager.check()).metadataSource, 'gitee');
  assert.equal(githubRequests, 1);
  assert.equal(manager.state.latestVersion, '2.5.0');
  await manager.setSource('gitee');
  assert.equal(githubRequests, 1, 'domestic-only checking never contacts GitHub');
  assert.ok(giteeRequests >= 2);
  const restored = new UpdateManager({ bundledRuntime: runtime, userData, fetchImpl });
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.source, 'gitee');
  await restored.check();
  assert.equal(githubRequests, 1);
  await assert.rejects(restored.setSource('unknown'), /无效的更新源/);
});

test('damaged downloads are rejected before extraction or version switch', async t => {
  const userData = await directory(t);
  const manager = new UpdateManager({ bundledRuntime: runtime, userData,
    manifest: { ...manifest, version: '2.4.0' },
    fetchImpl: async url => String(url).includes('api.github.com') ? Response.json(release(5)) : new Response('wrong'),
  });
  t.after(() => manager.close());
  await manager.initialize();
  await manager.check();
  assert.equal((await manager.prepare()).phase, 'error');
  assert.equal(manager.runtime, runtime);
  assert.equal(manager.current.version, '2.4.0');
  await assert.rejects(fs.access(join(userData, 'updates/pending.json')));
  assert.equal((await fs.readdir(join(userData, 'updates'))).some(name => name.startsWith('.s-')), false);
});

test('same-version replacement builds are offered without accepting older versions', async t => {
  const userData = await directory(t);
  const metadata = release(100);
  metadata.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  const manager = new UpdateManager({ bundledRuntime: runtime, userData, fetchImpl: async () => Response.json(metadata) });
  t.after(() => manager.close());
  await manager.initialize();
  assert.equal((await manager.check()).phase, 'available');
  metadata.tag_name = 'v2.4.0';
  metadata.assets[0].browser_download_url = metadata.assets[0].browser_download_url.replace('v2.5.0', 'v2.4.0');
  assert.equal((await manager.check()).phase, 'current');
});

test('canceled download cleans its staging directory and retains the original version', async t => {
  const userData = await directory(t);
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const manager = new UpdateManager({ bundledRuntime: runtime, userData, manifest: { ...manifest, version: '2.4.0' },
    fetchImpl: async (url, options) => {
      if (String(url).includes('api.github.com')) return Response.json(release(100));
      began();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true }));
    },
  });
  await manager.initialize(); await manager.check();
  const download = manager.prepare(); await started; await manager.close(); await download;
  assert.equal(manager.current.version, '2.4.0');
  assert.equal(manager.runtime, runtime);
  assert.deepEqual(await fs.readdir(join(userData, 'updates')), []);
});

test('verified official ZIP: download, mirror fallback, real candidate boot, restart activation and config rollback', { timeout: 120000 }, async t => {
  const userData = await directory(t);
  const size = (await fs.stat(archive)).size;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size });
    createReadStream(archive).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let githubFailed = false, mirrorUsed = false;
  const fetchImpl = async (url, options) => {
    const target = String(url);
    if (target.includes('api.github.com')) return Response.json(release(size));
    if (target.startsWith('https://github.com/')) { githubFailed = true; throw new Error('Simulated blocked GitHub asset'); }
    if (target.startsWith('https://gitee.com/')) { mirrorUsed = true; return fetch(`http://127.0.0.1:${server.address().port}/update.zip`, options); }
    return fetch(url, options);
  };
  const manager = new UpdateManager({ bundledRuntime: runtime, userData, manifest: { ...manifest, version: '2.4.0' }, fetchImpl });
  t.after(() => manager.close());
  await fs.mkdir(join(userData, 'core'), { recursive: true });
  const originalConfig = JSON.stringify({ version: 1, site: 'http://127.0.0.1:8787', localAccessPassword: 'test-passphrase' });
  await fs.writeFile(join(userData, 'core/client.json'), originalConfig);
  await manager.initialize();
  assert.equal((await manager.check()).phase, 'available');
  const phases = [];
  manager.on('state', state => phases.push(state.phase));
  assert.equal((await manager.prepare()).phase, 'ready');
  assert.ok(githubFailed && mirrorUsed);
  assert.ok(phases.includes('downloading') && phases.includes('verifying'));
  assert.equal(manager.runtime, runtime, 'download never changes the current running runtime');
  assert.equal(await fs.readFile(join(userData, 'core/client.json'), 'utf8'), originalConfig);
  const next = new UpdateManager({ bundledRuntime: runtime, userData, manifest: { ...manifest, version: '2.4.0' }, fetchImpl });
  t.after(() => next.close());
  await next.initialize();
  assert.equal(next.current.version, '2.5.0');
  assert.notEqual(next.runtime, runtime);
  const core = new Backend(next.runtime, join(userData, 'core'));
  t.after(() => core.stop());
  const launcher = await core.start();
  const state = await fetch(new URL('/api/client-launcher', launcher)).then(response => response.json());
  assert.equal(state.version.replace(/^v/, ''), '2.5.0');
  await core.stop();
  // Reproduce a newer core changing settings before an unsuccessful startup.
  await fs.writeFile(join(userData, 'core/client.json'), '{"version":999}');
  await fs.writeFile(join(userData, 'core/client.json.new-field'), 'new');
  assert.equal(await next.rollback('Simulated incompatible startup'), true);
  assert.equal(next.runtime, runtime);
  assert.equal(next.current.version, '2.4.0');
  assert.equal(await fs.readFile(join(userData, 'core/client.json'), 'utf8'), originalConfig);
  await assert.rejects(fs.access(join(userData, 'core/client.json.new-field')));
  assert.equal((await fs.readdir(join(userData, 'updates'))).some(name => name.startsWith('.s-')), false);
});

test('Gitee-only mode verifies and stages the full official ZIP without GitHub metadata or downloads', { timeout: 120000 }, async t => {
  const userData = await directory(t);
  const size = (await fs.stat(archive)).size;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': size });
    createReadStream(archive).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let githubRequests = 0;
  const manager = new UpdateManager({ bundledRuntime: runtime, userData, manifest: { ...manifest, version: '2.4.0' },
    fetchImpl: async (url, options) => {
      if (/github\.com/.test(String(url))) { githubRequests++; throw new Error('GitHub must not be contacted'); }
      if (String(url).includes('gitee.com/api/')) return Response.json([mirror()]);
      if (String(url).startsWith('https://gitee.com/')) return fetch(`http://127.0.0.1:${server.address().port}/update.zip`, options);
      return fetch(url, options);
    },
  });
  t.after(() => manager.close());
  await manager.initialize();
  assert.equal((await manager.setSource('gitee')).phase, 'available');
  assert.equal((await manager.prepare()).phase, 'ready');
  assert.equal(manager.pending.revision, manifest.revision);
  assert.equal(githubRequests, 0);
  assert.equal(manager.current.version, '2.4.0');
});
