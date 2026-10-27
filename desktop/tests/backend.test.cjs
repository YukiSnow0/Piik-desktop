const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { Backend, parseInvite } = require('../backend.cjs');

test('invitation preserves room fragment and rejects executable URLs', () => {
  assert.equal(parseInvite(' https://piik.example/?a=1#secret=abc '), 'https://piik.example/?a=1#secret=abc');
  for (const value of ['javascript:alert(1)', 'file:///C:/Windows', 'https://user:password@example.com', 'not a URL']) {
    assert.throws(() => parseInvite(value));
  }
});

test('released core: launcher, local room, source capabilities and clean shutdown', { timeout: 60000 }, async t => {
  const directory = resolve(__dirname, '../../build/desktop-tests', `core-${Date.now()}`);
  const backend = new Backend(resolve(__dirname, '../../build/desktop-engine/piik'), directory);
  t.after(() => backend.stop());
  const launcher = await backend.start();
  const origin = new URL(launcher).origin;
  let response = await fetch(origin + '/api/client-launcher');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.ok(state.controlPort > 0);
  assert.equal(state.starting, false);
  assert.ok(!state.target, 'does not start sharing or a room without a selection');
  const health = await fetch(`http://127.0.0.1:${state.controlPort}/health`, { headers: { Origin: origin } }).then(r => r.json());
  assert.equal(health.service, 'piik-client');
  assert.equal(typeof health.nativeMedia.video, 'boolean');
  const address = state.lan?.selected || state.lan?.addresses?.[0]?.address;
  assert.ok(address, `no test LAN address available: ${JSON.stringify(state.lan)}`);
  response = await fetch(origin + '/api/client-launcher/launch', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'local', language: 'zh', lanAddress: address, localAccessPassword: '' }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const target = (await response.json()).target;
  assert.match(target, /127\.0\.0\.1:8787/);
  assert.match(target, /piik-client/);
  const document = await fetch(target);
  assert.equal(document.status, 200);
  assert.match(await document.text(), /<html/);
  await backend.stop();
  await assert.rejects(fetch(origin + '/api/client-launcher'));
  await assert.rejects(fetch('http://127.0.0.1:8787/'));
});

test('missing runtime produces an actionable error and retires cleanly', { timeout: 10000 }, async t => {
  const directory = resolve(__dirname, '../../build/desktop-tests/missing');
  const backend = new Backend(join(directory, 'does-not-exist'), directory);
  t.after(() => backend.stop());
  await assert.rejects(backend.start(), /无法启动 Piik 服务/);
  await backend.stop();
});

test('exit during initial directory preparation never starts an orphan core', async () => {
  const directory = resolve(__dirname, '../../build/desktop-tests', `cancel-${Date.now()}`);
  const backend = new Backend(resolve(__dirname, '../../build/desktop-engine/piik'), directory);
  const starting = backend.start();
  await backend.stop();
  await assert.rejects(starting, /启动已取消/);
  assert.equal(backend.child, null);
});
