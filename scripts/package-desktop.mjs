import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('pnpm', ['build']);
run('pnpm', ['--filter', '@guhbot/desktop', 'build']);
const staging = resolve('release/desktop-bundle');
rmSync(staging, { recursive: true, force: true });
mkdirSync(`${staging}/dist/main`, { recursive: true });
cpSync('apps/desktop/dist/renderer', `${staging}/dist/renderer`, {
  recursive: true,
});
cpSync('apps/desktop/dist/preload', `${staging}/dist/preload`, {
  recursive: true,
});
cpSync('LICENSE', `${staging}/LICENSE`);
const browserRequire = createRequire(resolve('packages/browser/package.json'));
const playwrightRoot = resolve(
  browserRequire.resolve('playwright-core/package.json'),
  '..',
);
cpSync(playwrightRoot, `${staging}/node_modules/playwright-core`, {
  recursive: true,
});
writeFileSync(
  `${staging}/package.json`,
  JSON.stringify({
    name: 'guhbot-desktop',
    productName: 'Guh Bot',
    version: '0.2.0',
    main: 'dist/main/index.cjs',
    license: 'Apache-2.0',
  }),
);
// A bundled main process keeps pnpm workspace links and development dependencies
// out of the distributable. Electron and Node builtins remain runtime imports.
run('pnpm', [
  'exec',
  'esbuild',
  'apps/desktop/src/main/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--external:electron',
  '--external:playwright-core',
  `--outfile=${staging}/dist/main/index.cjs`,
  '--target=node22',
]);
run('pnpm', [
  'exec',
  'electron-packager',
  staging,
  'Guh Bot',
  '--platform=darwin',
  `--arch=${process.arch}`,
  '--electron-version=38.8.6',
  '--out=release',
  '--asar',
  '--overwrite',
  '--app-bundle-id=bot.guhbot.desktop',
  '--app-version=0.2.0',
  '--prune=false',
  '--icon=apps/desktop/assets/guh.icns',
]);
