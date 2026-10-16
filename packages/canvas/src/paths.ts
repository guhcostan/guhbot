import { join, resolve } from 'node:path';

/**
 * Where this capability is allowed to write.
 *
 * Two separate roots, because they are two different things:
 *
 *  - `<dataDir>/canvas` holds **canvases**: HTML this host sandboxes and serves
 *    by content address, split into immutable objects and their metadata.
 *  - `<dataDir>/artifacts` holds **artifacts**: ordinary files on disk. It is
 *    deliberately the same directory `@guhbot/host-core` serves from for
 *    `artifacts.get`, so a file written here is immediately retrievable by a
 *    client without a second store or a second copy.
 *
 * Keeping them apart is not tidiness. A canvas is bytes we control and can
 * guarantee things about; an artifact is a file whose lifetime, size and
 * contents belong to the user. Conflating them is how the sandbox guarantees
 * quietly stop being true.
 */
export interface CanvasPaths {
  readonly root: string;
  readonly objectsDir: string;
  readonly metaDir: string;
}

export function canvasPaths(dataDir: string): CanvasPaths {
  const root = resolve(dataDir, 'canvas');
  return { root, objectsDir: join(root, 'objects'), metaDir: join(root, 'meta') };
}

export function artifactRoot(dataDir: string): string {
  return resolve(dataDir, 'artifacts');
}
