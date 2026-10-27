import { readFile, writeFile, mkdir, cp, access, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const manifest = JSON.parse(await readFile(join(desktop, 'runtime.json'), 'utf8'));
const build = join(root, 'build/desktop-engine');
await mkdir(build, { recursive: true });
await mkdir(join(desktop, 'assets'), { recursive: true });
await Promise.all([
  cp(join(root, 'public/favicon.svg'), join(desktop, 'assets/favicon.svg')),
  cp(join(root, 'cmd/piik-app/piik.ico'), join(desktop, 'assets/piik.ico')),
  cp(join(root, 'src/client/ui/palette.css'), join(desktop, 'assets/palette.css')),
]);
try {
  if ((await readFile(join(build, 'piik/REVISION'), 'utf8')).trim() === manifest.revision) {
    await access(join(build, 'piik/piik-app.exe'));
    console.log(`Piik ${manifest.version} runtime already prepared.`);
    process.exit(0);
  }
} catch {}
const zip = join(build, 'upstream.zip');
const digest = data => createHash('sha256').update(data).digest('hex');
let bytes;
try { const cached = await readFile(zip); if (digest(cached) === manifest.sha256) bytes = cached; } catch {}
if (!bytes) {
  let lastError;
  for (const url of [manifest.url, manifest.mirrorUrl]) {
    try {
      console.log(`Downloading official Piik runtime from ${new URL(url).hostname}…`);
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const candidate = Buffer.from(await response.arrayBuffer());
      if (digest(candidate) !== manifest.sha256) throw new Error('Runtime SHA-256 mismatch');
      bytes = candidate;
      break;
    } catch (error) { lastError = error; console.log(error.message); }
  }
  if (!bytes) throw lastError;
  await writeFile(zip, bytes);
}
const extracted = join(build, 'extracted');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(extracted)} -Force`], { windowsHide: true, stdio: 'inherit' });
let source = extracted;
try { await access(join(source, 'piik-app.exe')); }
catch {
  for (const item of await readdir(extracted, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    try { await access(join(extracted, item.name, 'piik-app.exe')); source = join(extracted, item.name); break; } catch {}
  }
}
await access(join(source, 'piik-app.exe'));
if ((await readFile(join(source, 'REVISION'), 'utf8')).trim() !== manifest.revision) throw new Error('Unexpected upstream revision');
await cp(source, join(build, 'piik'), { recursive: true });
console.log(`Prepared verified Piik ${manifest.version}, ${manifest.revision.slice(0, 7)}.`);
