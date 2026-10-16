/**
 * Preload bridge.
 *
 * This is the entire surface the renderer can reach. Everything else is denied
 * by construction because the window runs with `contextIsolation: true`,
 * `nodeIntegration: false` and `sandbox: true`.
 *
 * The bridge deliberately exposes a *connection descriptor* rather than a
 * capability API. The renderer then talks to the host over the same wire
 * protocol a phone uses, so there is no privileged in-page API that could be
 * abused by a compromised renderer beyond what a paired device could do anyway.
 *
 * `token` is a credential. It is passed once at load, never written to
 * `localStorage`, and never exposed on `window` by anything other than this
 * frozen object.
 *
 * This file is `.cts` and uses `import ... = require(...)` on purpose. The
 * package is `type: module`, and a renderer created with `sandbox: true` cannot
 * load an ESM preload at all, so the emitted file has to be CommonJS — and under
 * `verbatimModuleSyntax` a `.cts` file may only use CommonJS import syntax.
 */
import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

export interface DesktopBridge {
  /** Where the embedded host is listening. */
  hostUrl: string;
  /** Person-class device token. Possession is equivalent to local presence. */
  token: string;
  platform: string;
  appVersion: string;
  /** Open a URL in the user's real browser rather than in-app. */
  openExternal: (url: string) => Promise<void>;
  /** Quit the application, closing the embedded host cleanly first. */
  quit: () => void;
}

const bridge: DesktopBridge = {
  hostUrl: String(ipcRenderer.sendSync('guhbot:bridge-info')?.hostUrl ?? ''),
  token: String(ipcRenderer.sendSync('guhbot:bridge-info')?.token ?? ''),
  platform: process.platform,
  appVersion: String(ipcRenderer.sendSync('guhbot:bridge-info')?.appVersion ?? '0.0.0'),
  openExternal: async (url: string) => {
    await ipcRenderer.invoke('guhbot:open-external', url);
  },
  quit: () => {
    ipcRenderer.send('guhbot:quit');
  },
};

contextBridge.exposeInMainWorld('guhbotDesktop', bridge);
