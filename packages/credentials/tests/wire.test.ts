import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCapability } from '@guhbot/agent';
import type { Session } from '@guhbot/host-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OriginCredentials } from '../src/index.js';
import { CREDENTIAL_VALUE, expectNoMaterial, mountCapability, storeValue, toolContext, toolOf, type Mounted } from './harness.js';

/**
 * The wire surface.
 *
 * A real `Host` dispatches every method a client can reach, so the assertions
 * here are about what a paired device — including one with no human presence —
 * can actually make the host do, not about what the method table says it should.
 */

const EXAMPLE = 'https://example.com';
const OTHER = 'https://other.example';

let dataDir: string;
let mounted: Mounted | undefined;

function current(): Mounted {
  if (mounted === undefined) throw new Error('test setup error: no host mounted');
  return mounted;
}

function vault(): OriginCredentials {
  return current().capability.credentials;
}

function local(): Session {
  return current().host.createSession('local');
}

/** A phone that redeemed a pairing code: paired, and never person-class. */
function background(): Session {
  const host = current().host;
  const { pairingId, code } = host.beginPairing();
  const { device } = host.claimPairing({
    pairingId,
    code,
    deviceName: 'phone',
    platform: 'ios',
    requestedClass: 'background',
  });
  return host.createSession('network', device);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'guhbot-credentials-wire-'));
  mounted = mountCapability({ dataDir });
});

afterEach(async () => {
  if (mounted !== undefined) await mounted.host.close();
  mounted = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('capability surface', () => {
  it('satisfies the capability contract and declares the credentials flag', () => {
    const { capability, flags } = current();
    expect(() => assertCapability(capability)).not.toThrow();
    expect(capability.name).toBe('credentials');
    expect(capability.flags).toEqual({ credentials: true });
    expect(flags).toEqual({ credentials: true });
    expect(capability.summary.length).toBeGreaterThan(10);
    expect(typeof capability.dispose).toBe('function');
  });

  it('contributes one read-only tool and exactly four methods', () => {
    const { tools, extraMethods } = current();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['credential_origins']);
    expect(Object.keys(extraMethods).sort()).toEqual([
      'credentials.list',
      'credentials.request',
      'credentials.revoke',
      'credentials.status',
    ]);
  });

  it('contributes no tool or method that can ask for a credential by name', () => {
    const { tools, extraMethods } = current();
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/credential_(use|get|read|show|reveal|value|fetch)/);
    }
    for (const name of Object.keys(extraMethods)) {
      expect(name).not.toMatch(/\.(get|read|use|reveal|show|value)$/);
    }
  });

  it('states requiresApproval on every tool, explicitly', () => {
    const tools = current().capability.tools?.() ?? [];
    expect(tools).toHaveLength(1);
    for (const tool of tools) expect(typeof tool.requiresApproval).toBe('boolean');
    expect(toolOf(tools, 'credential_origins').requiresApproval).toBe(false);
  });

  it('gives every method an honest authorization class and a summary', () => {
    const { extraMethods } = current();
    const classes = Object.fromEntries(Object.entries(extraMethods).map(([name, method]) => [name, method.authz]));
    expect(classes).toEqual({
      // Observing state a person already approved is safe without a human.
      'credentials.list': 'background',
      'credentials.status': 'background',
      // Deciding is not.
      'credentials.request': 'person',
      'credentials.revoke': 'person',
    });
    for (const method of Object.values(extraMethods)) {
      expect(method.summary.length).toBeGreaterThan(10);
      expect(['person', 'background']).toContain(method.authz);
    }
  });

  it('reports the same classes through host.describe', async () => {
    const described = (await current().host.dispatch(local(), 'host.describe', {})) as {
      methods: { name: string; authz: string; summary: string }[];
    };
    const mine = described.methods.filter((method) => method.name.startsWith('credentials.'));
    expect(mine.map((method) => `${method.name}:${method.authz}`)).toEqual([
      'credentials.list:background',
      'credentials.request:person',
      'credentials.revoke:person',
      'credentials.status:background',
    ]);
  });
});

describe('authorization boundary', () => {
  it('lets a background device list origins and read the policy', async () => {
    vault().approve(EXAMPLE);
    const device = background();

    const listed = (await current().host.dispatch(device, 'credentials.list', {})) as { origins: { origin: string }[] };
    expect(listed.origins.map((entry) => entry.origin)).toEqual([EXAMPLE]);

    const status = (await current().host.dispatch(device, 'credentials.status', {})) as {
      approved: number;
      policy: { schemes: string[] };
    };
    expect(status.approved).toBe(1);
    expect(status.policy.schemes).toEqual(['https']);
  });

  it('refuses credentials.request from a device without human presence', async () => {
    await expect(current().host.dispatch(background(), 'credentials.request', { origin: EXAMPLE })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(vault().list()).toEqual([]);
  });

  it('refuses credentials.revoke from a device without human presence, and revokes nothing', async () => {
    const approval = vault().approve(EXAMPLE);
    await expect(current().host.dispatch(background(), 'credentials.revoke', { origin: EXAMPLE })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(vault().list()[0]?.state).toBe('approved');
    expect(vault().list()[0]?.approvedAt).toBe(approval.approvedAt);
  });

  it('does not put the credential into a refusal', async () => {
    storeValue(current().host, EXAMPLE);
    const error: unknown = await current()
      .host.dispatch(background(), 'credentials.request', { origin: EXAMPLE })
      .then(
        () => new Error('expected a refusal'),
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(Error);
    expectNoMaterial(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  });

  it('lets a person-class session approve and revoke', async () => {
    const approved = (await current().host.dispatch(local(), 'credentials.request', { origin: EXAMPLE })) as {
      origin: string;
      state: string;
      summary: string;
    };
    expect(approved.origin).toBe(EXAMPLE);
    expect(approved.state).toBe('approved');
    expect(approved.summary).toBe(`Allow credential use for ${EXAMPLE}`);

    const revoked = (await current().host.dispatch(local(), 'credentials.revoke', { origin: EXAMPLE })) as {
      revoked: boolean;
      forgotten: boolean;
    };
    expect(revoked).toMatchObject({ revoked: true, forgotten: false });
    expect(vault().list()[0]?.state).toBe('revoked');
  });

  it('refuses a malformed request before the handler runs', async () => {
    await expect(current().host.dispatch(local(), 'credentials.request', {})).rejects.toMatchObject({ code: 'bad-request' });
    await expect(current().host.dispatch(local(), 'credentials.request', { origin: '' })).rejects.toMatchObject({
      code: 'bad-request',
    });
    await expect(current().host.dispatch(local(), 'credentials.request', { origin: 'http://example.com' })).rejects.toMatchObject({
      code: 'bad-request',
    });
    expect(vault().list()).toEqual([]);
  });
});

describe('the protocol never carries a credential', () => {
  it('returns no material from any contributed method', async () => {
    storeValue(current().host, EXAMPLE);
    const { extraMethods } = current();

    const responses: string[] = [
      JSON.stringify(await current().host.dispatch(local(), 'credentials.request', { origin: EXAMPLE })),
      JSON.stringify(await current().host.dispatch(local(), 'credentials.list', {})),
      JSON.stringify(await current().host.dispatch(local(), 'credentials.status', {})),
      JSON.stringify(await current().host.dispatch(local(), 'credentials.revoke', { origin: EXAMPLE })),
    ];

    // One response per contributed method: a new method must be added here.
    expect(responses).toHaveLength(Object.keys(extraMethods).length);
    for (const response of responses) expectNoMaterial(response);
  });

  it('returns no material from the credential_origins tool', async () => {
    storeValue(current().host, EXAMPLE);
    vault().approve(EXAMPLE);

    const output = await toolOf(current().tools, 'credential_origins').execute({}, toolContext());
    expectNoMaterial(output);

    const parsed = JSON.parse(output) as { origins: { origin: string; approvedAt: string }[] };
    expect(parsed.origins).toHaveLength(1);
    expect(parsed.origins[0]?.origin).toBe(EXAMPLE);
    expect(parsed.origins[0]?.approvedAt).toBe(vault().list()[0]?.approvedAt);
  });

  it('lists nothing at all for an origin that has no approval', async () => {
    storeValue(current().host, EXAMPLE);
    const output = await toolOf(current().tools, 'credential_origins').execute({}, toolContext());
    expectNoMaterial(output);
    expect(JSON.parse(output)).toMatchObject({ origins: [] });
  });

  it('does not reveal which approved origins actually hold a value', async () => {
    storeValue(current().host, EXAMPLE);
    vault().approve(EXAMPLE);
    vault().approve(OTHER);

    const output = await toolOf(current().tools, 'credential_origins').execute({}, toolContext());
    expectNoMaterial(output);
    const parsed = JSON.parse(output) as { origins: Record<string, unknown>[] };
    expect(parsed.origins.map((entry) => entry['origin'])).toEqual([EXAMPLE, OTHER]);
    // Same fields for both, so the listing cannot be read as "this one is loaded".
    expect(new Set(parsed.origins.map((entry) => Object.keys(entry).sort().join(','))).size).toBe(1);
    // The only way to tell them apart is to try, and a try is an in-tool release.
    expect(await vault().release(EXAMPLE)).not.toBeNull();
    await expect(vault().release(OTHER)).resolves.toBeNull();
  });
});

describe('lifecycle', () => {
  it('disposes idempotently and releases nothing afterwards', async () => {
    storeValue(current().host, EXAMPLE);
    vault().approve(EXAMPLE);
    expect(await current().capability.provider.release(EXAMPLE)).not.toBeNull();

    const { capability } = current();
    await capability.dispose?.();
    await capability.dispose?.();
    await capability.dispose?.();

    await expect(capability.provider.release(EXAMPLE)).resolves.toBeNull();
    expect(() => vault().approve(OTHER)).toThrow();
  });

  it('exposes the release seam the browser capability is expected to consume', () => {
    const { provider } = current().capability;
    expect(typeof provider.release).toBe('function');
    expect(provider.release.length).toBe(1);
  });
});

describe('fixture sanity', () => {
  it('the value used by these tests is not a real credential', () => {
    expect(CREDENTIAL_VALUE).toContain('fixture');
  });
});
