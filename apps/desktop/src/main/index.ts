/**
 * Electron main process.
 *
 * Responsibilities, in order: start the embedded host, open exactly one hardened
 * window pointed at it, and shut both down together. Any real logic lives in
 * `bootstrap.ts` so it can be tested without Electron.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapHost, type BootstrapResult } from './bootstrap.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP_VERSION = '0.1.0';

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
    title: 'guhbot',
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
  // The host owns the durable data. Electron's own userData directory is the
  // right home for it: it is per-user, per-app, and already backed up correctly.
  const dataDir = join(app.getPath('userData'), 'host');

  try {
    bootstrapped = await bootstrapHost({
      dataDir,
      version: APP_VERSION,
      cwd: process.cwd(),
      ...(process.env['GUHBOT_BASE_URL'] !== undefined ? { baseUrl: process.env['GUHBOT_BASE_URL'] } : {}),
      ...(process.env['GUHBOT_API_KEY'] !== undefined ? { apiKey: process.env['GUHBOT_API_KEY'] } : {}),
      ...(process.env['GUHBOT_MODEL'] !== undefined ? { model: process.env['GUHBOT_MODEL'] } : {}),
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
