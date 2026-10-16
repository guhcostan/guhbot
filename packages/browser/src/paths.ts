import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { resolveInside } from '@guhbot/agent';

/**
 * Where this capability is allowed to write.
 *
 * Everything lives under one root, `<dataDir>/browser`, so an operator can see,
 * back up or delete the whole footprint in one move. The profile is separate
 * from the screenshots because their lifetimes differ: the profile is ephemeral
 * (it holds cookies and storage from whatever the agent browsed) while a
 * screenshot is a deliverable the user asked for.
 */
export interface BrowserPaths {
  readonly root: string;
  readonly profileDir: string;
  readonly screenshotDir: string;
}

export function browserPaths(dataDir: string): BrowserPaths {
  const root = resolve(dataDir, 'browser');
  return { root, profileDir: join(root, 'profile'), screenshotDir: join(root, 'screenshots') };
}

let screenshotCounter = 0;

/**
 * Resolve a screenshot destination, refusing anything outside the directory.
 *
 * A model-supplied filename is a path from an untrusted source and goes through
 * `resolveInside` before it touches the filesystem, exactly like every other
 * path in this repository. The `.png` requirement is not cosmetic: the tool
 * writes whatever the browser produced, and a caller that can choose the
 * extension can choose how some other program will interpret those bytes later.
 */
export async function resolveScreenshotPath(screenshotDir: string, requested?: string): Promise<string> {
  await mkdir(screenshotDir, { recursive: true, mode: 0o700 });

  const wanted = requested?.trim() ?? '';
  if (wanted === '') {
    screenshotCounter += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(screenshotDir, `shot-${stamp}-${screenshotCounter}.png`);
  }

  if (!wanted.toLowerCase().endsWith('.png')) {
    throw new Error(`screenshot names must end in .png, got ${JSON.stringify(requested)}`);
  }
  if (basename(wanted) === '' || wanted.endsWith('/')) {
    throw new Error(`screenshot name ${JSON.stringify(requested)} is a directory, not a file`);
  }
  return resolveInside(screenshotDir, wanted);
}
