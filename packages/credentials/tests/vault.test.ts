import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostError, type Host } from '@guhbot/host-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_RECORD_KIND,
  CREDENTIAL_NAME_PREFIX,
  approvalRecordName,
  credentialSecretName,
  type OriginCredentials,
} from '../src/index.js';
import { CREDENTIAL_VALUE, mountCapability, storeValue, type Mounted } from './harness.js';

/**
 * The vault's behaviour: approval, release, revocation, and what storage
 * actually contains.
 *
 * Every test drives a real `Host` over a real temporary data directory, so the
 * sealed rows are produced and opened by `host-core`'s own box. Nothing here
 * reaches the network and the credential material is a fixture.
 */

let dataDir: string;
let mounted: Mounted | undefined;

const EXAMPLE = 'https://example.com';
const OTHER = 'https://other.example';

function boot(now?: () => number): void {
  mounted = mountCapability({ dataDir, ...(now !== undefined ? { now } : {}) });
}

function vault(): OriginCredentials {
  if (mounted === undefined) throw new Error('test setup error: no host mounted');
  return mounted.capability.credentials;
}

function host(): Host {
  if (mounted === undefined) throw new Error('test setup error: no host mounted');
  return mounted.host;
}

async function restart(now?: () => number): Promise<void> {
  if (mounted !== undefined) await mounted.host.close();
  mounted = undefined;
  boot(now);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-credentials-'));
  boot();
});

afterEach(async () => {
  if (mounted !== undefined) await mounted.host.close();
  mounted = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('approval', () => {
  it('releases nothing for an origin nobody approved', async () => {
    storeValue(host(), EXAMPLE);
    await expect(vault().release(EXAMPLE)).resolves.toBeNull();
    expect(vault().list()).toEqual([]);
    expect(vault().counts()).toEqual({ approved: 0, revoked: 0 });
  });

  it('releases the stored value once the origin has been approved', async () => {
    storeValue(host(), EXAMPLE);
    const approval = vault().approve(EXAMPLE);

    expect(approval.state).toBe('approved');
    const released = await vault().release(EXAMPLE);
    expect(released?.value).toBe(CREDENTIAL_VALUE);
    expect(released?.origin).toBe(EXAMPLE);
    expect(released?.approvedAt).toBe(approval.approvedAt);
  });

  it('records the origin, the decision, when, and the sentence the person saw', () => {
    const approval = vault().approve(EXAMPLE);
    expect(approval).toEqual({
      v: 1,
      kind: APPROVAL_RECORD_KIND,
      origin: EXAMPLE,
      state: 'approved',
      summary: `Allow credential use for ${EXAMPLE}`,
      approvedAt: approval.approvedAt,
      revokedAt: null,
    });
    expect(vault().list()).toEqual([approval]);
  });

  it('shows the person the origin and nothing else', () => {
    storeValue(host(), EXAMPLE);
    const approval = vault().approve(EXAMPLE);
    expect(approval.summary).toBe('Allow credential use for https://example.com');
    expect(approval.summary).not.toContain(CREDENTIAL_VALUE);
    expect(Object.keys(approval).sort()).toEqual([
      'approvedAt',
      'kind',
      'origin',
      'revokedAt',
      'state',
      'summary',
      'v',
    ]);
  });

  it('returns the value byte for byte, whatever the operator stored', async () => {
    const value = '{"cookies":[{"name":"sid","value":"üñïçø∂é"}],"notes":"line one\\nline two\\ttabbed"}';
    storeValue(host(), EXAMPLE, value);
    vault().approve(EXAMPLE);
    expect((await vault().release(EXAMPLE))?.value).toBe(value);
  });

  it('approves an origin that has no value yet, and still releases nothing', async () => {
    vault().approve(EXAMPLE);
    expect(vault().approvedOrigins().map((record) => record.origin)).toEqual([EXAMPLE]);
    await expect(vault().release(EXAMPLE)).resolves.toBeNull();
  });

  it('keeps one approval per origin and replaces it on a second request', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    await restart(() => clock);
    const first = vault().approve(EXAMPLE);
    clock += 60_000;
    const second = vault().approve(EXAMPLE);
    expect(second.approvedAt).not.toBe(first.approvedAt);
    expect(vault().list()).toHaveLength(1);
    expect(vault().list()[0]?.approvedAt).toBe(second.approvedAt);
  });
});

describe('the matcher is the gate', () => {
  it('releases nothing to a lookalike of an approved origin', async () => {
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);

    const lookalikes = [
      'https://example.com.evil.com',
      'https://evil.com',
      'https://notexample.com',
      'https://app.example.com',
      'https://example.co',
      'https://xn--exmple-cua.com',
      'https://exämple.com',
      'http://example.com',
      'https://example.com:8443',
    ];
    // Store a decoy under each lookalike's own name too, so a refusal cannot be
    // explained away by "there was nothing there to release". A plaintext
    // origin cannot have a row at all, which is itself part of the design.
    for (const candidate of lookalikes) {
      if (credentialSecretName(candidate) !== null) storeValue(host(), candidate, `decoy:${candidate}`);
    }

    for (const candidate of lookalikes) {
      expect(await vault().release(candidate), candidate).toBeNull();
    }
    expect(await vault().release(EXAMPLE)).not.toBeNull();
  });

  it('refuses a URL, which is not an origin', async () => {
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);
    for (const input of [
      'https://example.com/login',
      'https://example.com/?q=1',
      'https://example.com#fragment',
      'https://user@example.com',
      'http://example.com',
      'example.com',
      '',
    ]) {
      expect(await vault().release(input), input).toBeNull();
    }
  });

  it('refuses a value stored under a name that is not canonical', async () => {
    // The naming contract is part of the security model: a row that was not
    // named by `credentialSecretName` is not found, and is not silently matched.
    host().putSecret(`${CREDENTIAL_NAME_PREFIX}https://EXAMPLE.com`, CREDENTIAL_VALUE, null);
    vault().approve(EXAMPLE);
    await expect(vault().release(EXAMPLE)).resolves.toBeNull();
  });

  it('refuses to approve or revoke anything that is not an https origin', () => {
    for (const input of ['http://example.com', 'https://example.com/login', 'https://user@example.com', 'nonsense']) {
      expect(() => vault().approve(input), input).toThrow(HostError);
      expect(() => vault().revoke(input), input).toThrow(HostError);
    }
    expect(vault().list()).toEqual([]);
  });

  it('does not echo the refused input back in the error message', () => {
    const smuggled = `https://example.com/login?token=${CREDENTIAL_VALUE}`;
    try {
      vault().approve(smuggled);
      throw new Error('expected approve to refuse');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(CREDENTIAL_VALUE);
      expect(message).toContain('https origin');
    }
  });
});

describe('revocation', () => {
  it('stops releasing immediately', async () => {
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);
    expect(await vault().release(EXAMPLE)).not.toBeNull();

    const result = vault().revoke(EXAMPLE);
    expect(result.approval?.state).toBe('revoked');
    expect(result.forgotten).toBe(false);
    await expect(vault().release(EXAMPLE)).resolves.toBeNull();
  });

  it('stops a release that is already in flight', async () => {
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);

    const inFlight = vault().release(EXAMPLE);
    vault().revoke(EXAMPLE);
    await expect(inFlight).resolves.toBeNull();
  });

  it('stops a release whose approval was replaced underneath it', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    await restart(() => clock);
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);

    const inFlight = vault().release(EXAMPLE);
    clock += 1000;
    // Revoked and approved again: the row says `approved`, but it is not the
    // decision this release started under, so the release must refuse.
    vault().revoke(EXAMPLE);
    vault().approve(EXAMPLE);
    await expect(inFlight).resolves.toBeNull();
  });

  it('keeps the row and both timestamps for audit', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    await restart(() => clock);
    const approved = vault().approve(EXAMPLE);
    clock += 5000;
    vault().revoke(EXAMPLE);

    const record = vault().list()[0];
    expect(record?.state).toBe('revoked');
    expect(record?.approvedAt).toBe(approved.approvedAt);
    expect(record?.revokedAt).toBe(new Date(clock).toISOString());
    expect(vault().counts()).toEqual({ approved: 0, revoked: 1 });
  });

  it('does not delete the sealed value unless asked', () => {
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);
    vault().revoke(EXAMPLE);
    expect(host().store.readSealedSecret(`origin:${EXAMPLE}`)).not.toBeNull();
  });

  it('forgets the sealed value when asked', async () => {
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);
    const result = vault().revoke(EXAMPLE, true);
    expect(result.forgotten).toBe(true);
    expect(host().store.readSealedSecret(`origin:${EXAMPLE}`)).toBeNull();
    // Re-approving no longer helps: the material is gone.
    vault().approve(EXAMPLE);
    await expect(vault().release(EXAMPLE)).resolves.toBeNull();
  });

  it('reports nothing to revoke for an origin that was never approved', () => {
    const result = vault().revoke(OTHER);
    expect(result).toEqual({ origin: OTHER, approval: null, forgotten: false });
    expect(vault().list()).toEqual([]);
  });

  it('restores release when the origin is approved again', async () => {
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);
    vault().revoke(EXAMPLE);
    vault().approve(EXAMPLE);
    const released = await vault().release(EXAMPLE);
    expect(released?.value).toBe(CREDENTIAL_VALUE);
    expect(vault().list()[0]?.revokedAt).toBeNull();
  });

  it('survives a restart, in both directions', async () => {
    storeValue(host(), EXAMPLE);
    storeValue(host(), OTHER);
    vault().approve(EXAMPLE);
    vault().approve(OTHER);
    vault().revoke(OTHER);

    await restart();

    expect(vault().approvedOrigins().map((record) => record.origin)).toEqual([EXAMPLE]);
    expect(vault().list().map((record) => record.state)).toEqual(['approved', 'revoked']);
    expect((await vault().release(EXAMPLE))?.value).toBe(CREDENTIAL_VALUE);
    await expect(vault().release(OTHER)).resolves.toBeNull();
  });
});

describe('storage', () => {
  it('seals the value: what is on disk is not the plaintext', () => {
    const name = storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);

    const sealedValue = host().store.readSealedSecret(name);
    const sealedApproval = host().store.readSealedSecret(approvalRecordName(EXAMPLE));
    expect(sealedValue).not.toBeNull();
    expect(sealedApproval).not.toBeNull();
    for (const row of [sealedValue, sealedApproval]) {
      expect(row).not.toContain(CREDENTIAL_VALUE);
      expect(row?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('stores the value and the approval as two rows in the host secret table', () => {
    const name = storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);
    const names = host().store.listSecrets().map((meta) => meta.name);
    expect(names).toContain(name);
    expect(names).toContain(approvalRecordName(EXAMPLE));
    expect(credentialSecretName(EXAMPLE)).toBe('origin:https://example.com');
  });

  it('refuses an approval row whose summary says anything but the origin', async () => {
    const forged = {
      v: 1,
      kind: APPROVAL_RECORD_KIND,
      origin: EXAMPLE,
      state: 'approved',
      // The shape of attack this defends against: smuggle material into a field
      // every client renders.
      summary: `Allow credential use for ${EXAMPLE}: ${CREDENTIAL_VALUE}`,
      approvedAt: new Date().toISOString(),
      revokedAt: null,
    };
    host().putSecret(approvalRecordName(EXAMPLE), JSON.stringify(forged), 'credentials');
    storeValue(host(), EXAMPLE);

    expect(vault().list()).toEqual([]);
    expect(vault().approvedOrigins()).toEqual([]);
    await expect(vault().release(EXAMPLE)).resolves.toBeNull();
  });

  it('refuses an approval row that will not open', async () => {
    host().store.putSecret(approvalRecordName(EXAMPLE), 'AAAAAAAAAAAAAAAAAAAA', 'credentials');
    storeValue(host(), EXAMPLE);
    expect(vault().list()).toEqual([]);
    await expect(vault().release(EXAMPLE)).resolves.toBeNull();
  });

  it('refuses a value row that will not open', async () => {
    host().store.putSecret(`origin:${EXAMPLE}`, 'AAAAAAAAAAAAAAAAAAAA', null);
    vault().approve(EXAMPLE);
    await expect(vault().release(EXAMPLE)).resolves.toBeNull();
  });

  it('ignores a well-formed approval stored under another origin name', () => {
    const record = {
      v: 1,
      kind: APPROVAL_RECORD_KIND,
      origin: EXAMPLE,
      state: 'approved',
      summary: `Allow credential use for ${EXAMPLE}`,
      approvedAt: new Date().toISOString(),
      revokedAt: null,
    };
    host().putSecret(approvalRecordName('https://elsewhere.example'), JSON.stringify(record), 'credentials');
    expect(vault().list()).toEqual([]);
  });

  it('never opens a row that is not part of this package', () => {
    // A corrupt seal under an unrelated name must not break listing, and must
    // not be opened at all: this package only ever opens its own prefixes.
    host().store.putSecret('portal-password', 'not-a-seal', null);
    expect(vault().list()).toEqual([]);
    expect(vault().counts()).toEqual({ approved: 0, revoked: 0 });
  });
});

describe('lifecycle', () => {
  it('dispose is idempotent and a disposed vault releases nothing', async () => {
    storeValue(host(), EXAMPLE);
    vault().approve(EXAMPLE);
    expect(await vault().release(EXAMPLE)).not.toBeNull();

    const credentials = vault();
    credentials.dispose();
    credentials.dispose();
    credentials.dispose();
    expect(credentials.isDisposed).toBe(true);

    await expect(credentials.release(EXAMPLE)).resolves.toBeNull();
    expect(() => credentials.approve(EXAMPLE)).toThrow(HostError);
  });
});
