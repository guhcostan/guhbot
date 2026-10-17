/**
 * Electron main process.
 *
 * Responsibilities, in order: start the embedded host, open exactly one hardened
 * window pointed at it, and shut both down together. Any real logic lives in
 * `bootstrap.ts` so it can be tested without Electron.
 */
import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron';
import { join, dirname, delimiter } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createCliEngines } from '@guhbot/engine-cli';
import { fileURLToPath } from 'node:url';
import { bootstrapHost, type BootstrapResult } from './bootstrap.js';

const here =
  typeof __dirname === 'string'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
const APP_VERSION = '0.2.0';

let bootstrapped: BootstrapResult | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * Window hardening.
 *
 * `sandbox: true` plus `contextIsolation: true` and `nodeIntegration: false`
 * means a renderer compromise cannot reach Node, the filesystem, or the host's
 * master key. `webSecurity` stays on. The renderer loads only local files, and
 * the CSP in index.html forbids remote script.
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'Guh Bot',
    backgroundColor: '#0b0d10',
    show: false,
    webPreferences: {
      // `.cjs`, not `.js`: this package is `type: module`, and a sandboxed
      // renderer cannot load an ESM preload at all. The source is `index.cts`
      // precisely so the emitted file is CommonJS.
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Navigation is denied outright: this is a single-page local app, and any
  // attempt to navigate away is either a bug or an attack.
  window.webContents.on('will-navigate', (event, url) => {
    const isLocal = url.startsWith('file://');
    if (!isLocal) {
      event.preventDefault();
      void shell.openExternal(url).catch(() => {
        /* the user's browser refusing a URL is not our problem */
      });
    }
  });

  // Never let the renderer open a window; route it to the real browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  const devUrl = process.env['GUHBOT_DEV_URL'];
  if (devUrl !== undefined) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(here, '../renderer/index.html'));
  }

  return window;
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light';
  process.env['PATH'] = [
    process.env['PATH'] ?? '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local/bin'),
  ].join(delimiter);
  // The host owns the durable data. Electron's own userData directory is the
  // right home for it: it is per-user, per-app, and already backed up correctly.
  const dataDir =
    process.env['GUHBOT_DATA_DIR'] ?? join(app.getPath('userData'), 'host');
  const workspace =
    process.env['GUHBOT_WORKSPACE'] ?? join(dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  let engine = process.env['GUHBOT_ENGINE'];
  if (!engine && !process.env['GUHBOT_BASE_URL']) {
    for (const candidate of createCliEngines()) {
      if ((await candidate.probe()).available) {
        engine = candidate.id;
        break;
      }
    }
  }

  try {
    bootstrapped = await bootstrapHost({
      dataDir,
      version: APP_VERSION,
      cwd: workspace,
      ...(process.env['GUHBOT_COMPANION_PORT']
        ? {
            companion: {
              port: Number(process.env['GUHBOT_COMPANION_PORT']),
              host: process.env['GUHBOT_COMPANION_HOST'] ?? '127.0.0.1',
              insecurePlaintext:
                process.env['GUHBOT_COMPANION_INSECURE'] === 'true',
              allowedHosts: (
                process.env['GUHBOT_COMPANION_ALLOWED_HOSTS'] ?? ''
              )
                .split(',')
                .filter(Boolean),
            },
          }
        : {}),
      ...(engine ? { engine } : {}),
      ...(process.env['GUHBOT_BASE_URL'] !== undefined
        ? { baseUrl: process.env['GUHBOT_BASE_URL'] }
        : {}),
      ...(process.env['GUHBOT_API_KEY'] !== undefined
        ? { apiKey: process.env['GUHBOT_API_KEY'] }
        : {}),
      ...(process.env['GUHBOT_MODEL'] !== undefined
        ? { model: process.env['GUHBOT_MODEL'] }
        : {}),
      allowedHosts: (process.env['GUHBOT_ALLOWED_HOSTS'] ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h.length > 0),
    });
  } catch (error) {
    // A host that cannot start must not leave a blank window with no explanation.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`fatal: host failed to start: ${message}\n`);
    app.exit(1);
    return;
  }

  // The preload needs the connection details synchronously at load, so the
  // renderer can build its client before the first paint.
  ipcMain.on('guhbot:bridge-info', (event) => {
    event.returnValue = {
      hostUrl: bootstrapped?.hostUrl ?? '',
      phoneUrl:
        process.env['GUHBOT_PUBLIC_URL'] ??
        bootstrapped?.companionUrl ??
        bootstrapped?.hostUrl ??
        '',
      token: bootstrapped?.rendererToken ?? '',
      appVersion: APP_VERSION,
    };
  });

  ipcMain.handle('guhbot:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      throw new Error('only http(s) URLs may be opened externally');
    }
    await shell.openExternal(url);
  });

  ipcMain.on('guhbot:quit', () => {
    app.quit();
  });

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Close the host before the process goes away, so runs in flight are marked
 * failed and SQLite is not left with a hot WAL from a killed process.
 */
let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown || bootstrapped === null) return;
  event.preventDefault();
  shuttingDown = true;
  void bootstrapped
    .close()
    .catch(() => {
      /* best effort: we are quitting either way */
    })
    .finally(() => {
      bootstrapped = null;
      app.quit();
    });
});
