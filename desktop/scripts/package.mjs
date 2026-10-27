import { packager } from '@electron/packager';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '..');
const metadata = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
execFileSync(process.execPath, [join(desktop, 'scripts/prepare-runtime.mjs')], { stdio: 'inherit' });
const paths = await packager({
  dir: desktop, out: join(root, 'build/desktop-package'), name: 'Piik Desktop',
  executableName: 'Piik Desktop', platform: 'win32', arch: 'x64', electronVersion: '45.0.0',
  appVersion: metadata.version, appCopyright: 'Piik contributors; desktop wrapper MIT',
  icon: join(desktop, 'assets/piik.ico'), asar: true, overwrite: true,
  tmpdir: join(root, 'build/desktop-package-temp'),
  download: { cacheRoot: join(root, 'build/electron-cache') },
  ...(process.env.PIIK_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.PIIK_ELECTRON_ZIP_DIR } : {}),
  ignore: [/^\/scripts($|\/)/, /^\/tests($|\/)/, /^\/package-lock\.json$/, /^\/README\.md$/],
  extraResource: [join(root, 'build/desktop-engine/piik')],
});
for (const target of paths) {
  await cp(join(root, 'LICENSE'), join(target, 'PIIK-LICENSE.txt'));
  await cp(join(desktop, 'README.md'), join(target, '使用说明.md'));
  console.log(`Portable desktop: ${target}`);
}
