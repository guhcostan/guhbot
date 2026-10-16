import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Secret storage.
 *
 * Secrets are the most dangerous thing this host holds: browser cookies, portal
 * passwords, API keys. Two rules apply everywhere in this file:
 *
 *  1. A secret value never crosses the protocol boundary. `secrets.list` returns
 *     metadata only; there is deliberately no `secrets.get`.
 *  2. A secret value is never written to disk in the clear. Values are sealed
 *     with AES-256-GCM under a key derived from a master key file that lives in
 *     the data directory with mode 0600.
 *
 * This is not protection against an attacker who already has your user account
 * — they can read the master key. It is protection against the realistic cases:
 * a database file copied to a backup, a support bundle, a synced folder, a
 * second user on the machine reading `data.db`.
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MASTER_KEY_FILE = 'master.key';

export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

/**
 * Load the master key, creating it on first run.
 *
 * The key file is written with `wx` so two concurrent host starts cannot race
 * and produce two different keys, one of which would silently fail to decrypt
 * everything the other wrote.
 */
export function loadOrCreateMasterKey(dataDir: string): Buffer {
  const keyPath = join(dataDir, MASTER_KEY_FILE);
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `master key at ${keyPath} is ${key.length} bytes, expected ${KEY_BYTES}. ` +
          'Refusing to start: a truncated key would make every stored secret unreadable.',
      );
    }
    return key;
  }

  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  try {
    writeFileSync(keyPath, key.toString('base64'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Lost the race: another process created it first, so use theirs.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return loadOrCreateMasterKey(dataDir);
    }
    throw error;
  }
  chmodSync(keyPath, 0o600);
  return key;
}

/**
 * Build a sealer from the master key.
 *
 * The master key is not used directly as an AES key. It is run through scrypt to
 * derive one, which costs an attacker a memory-hard step per guess if they get
 * the key file but not the (deliberately slow) derivation.
 */
export function createSecretBox(masterKey: Buffer): SecretBox {
  const aesKey = scryptSync(masterKey, 'guhbot-secret-box-v1', KEY_BYTES);

  return {
    seal(plaintext: string): string {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      // version || nonce || tag || ciphertext — self-describing so we can rotate later.
      return Buffer.concat([Buffer.from([1]), nonce, tag, ciphertext]).toString('base64');
    },

    open(sealed: string): string {
      const raw = Buffer.from(sealed, 'base64');
      if (raw.length < 1 + NONCE_BYTES + TAG_BYTES) {
        throw new Error('sealed secret is too short to be valid');
      }
      const version = raw[0];
      if (version !== 1) {
        throw new Error(`unsupported sealed-secret version ${version}`);
      }
      const nonce = raw.subarray(1, 1 + NONCE_BYTES);
      const tag = raw.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
      const ciphertext = raw.subarray(1 + NONCE_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}

/**
 * Hash a device token for storage.
 *
 * Device tokens are high-entropy (256 bits), so a fast hash is fine here — the
 * scrypt cost is pointless against a value that cannot be guessed. We keep the
 * salt so identical tokens across hosts do not produce identical hashes.
 */
export function hashToken(token: string, salt: Buffer): Buffer {
  return scryptSync(token, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function verifyToken(token: string, salt: Buffer, expected: Buffer): boolean {
  const actual = hashToken(token, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
