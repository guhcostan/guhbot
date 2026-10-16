import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Renderer build.
 *
 * Three settings here are load-bearing rather than taste:
 *
 *  - `base: './'` because the packaged app loads the page with `loadFile`, over
 *    the `file://` protocol. An absolute asset base would resolve to the
 *    filesystem root and the window would come up blank.
 *  - `root` is `src/renderer`, not the package directory, so `index.html` there
 *    is the entry and the built asset paths stay relative to it.
 *  - the output goes to `dist/renderer`, which is where `main/index.ts` loads it
 *    from. Changing one without the other gives a blank window with no error.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    // Electron ships its own Chromium, so there is no browser matrix to satisfy
    // and no reason to transpile down to it.
    target: 'chrome120',
    sourcemap: true,
  },
});
