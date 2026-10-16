import type { ToolDefinition, ToolExecutionContext } from '@guhbot/agent';
import { collectContributions } from '@guhbot/agent';
import type { ContributedMethod, Host } from '@guhbot/host-core';
import { Host as HostClass } from '@guhbot/host-core';
import { expect } from 'vitest';
import { createCredentialsCapability, credentialSecretName, type CredentialsCapability } from '../src/index.js';

/**
 * Test fixtures.
 *
 * Every test drives a real `Host` over a real temporary data directory: the
 * point of most of these tests is that the sealed rows live in the host's own
 * `secrets` table and open with the host's own key, and a fake store would
 * quietly stop testing that. The credential material below is a fixture, never
 * a real one.
 */

export const CREDENTIAL_VALUE = 'vault-fixture-cookie-jar-8f3a1c-do-not-log';

export interface MountOptions {
  readonly dataDir: string;
  /** Injectable clock, so a test can make two approvals distinguishable. */
  readonly now?: () => number;
}

export interface Mounted {
  readonly host: Host;
  readonly capability: CredentialsCapability;
  readonly tools: ToolDefinition[];
  readonly extraMethods: Record<string, ContributedMethod>;
  readonly flags: Record<string, boolean>;
}

/** Build the capability, then the host, exactly the way the runtime does. */
export function mountCapability(options: MountOptions): Mounted {
  let host: Host | null = null;
  const capability = createCredentialsCapability({
    host: () => {
      if (host === null) throw new Error('test harness: the vault was used before the host existed');
      return host;
    },
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const contributions = collectContributions([capability]);
  host = new HostClass({
    dataDir: options.dataDir,
    version: '0.0.0-test',
    mode: 'self-hosted',
    capabilities: { credentials: true, ...contributions.flags },
    extraMethods: contributions.extraMethods,
  });

  return {
    host,
    capability,
    tools: contributions.tools,
    extraMethods: contributions.extraMethods,
    flags: contributions.flags,
  };
}

/** Store a credential value the way an operator would: the host's own write. */
export function storeValue(host: Host, origin: string, value: string = CREDENTIAL_VALUE): string {
  const name = credentialSecretName(origin);
  if (name === null) throw new Error(`test fixture: ${origin} is not an approvable origin`);
  host.putSecret(name, value, null);
  return name;
}

export function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool;
}

export function toolContext(): ToolExecutionContext {
  return {
    readSecret: () => null,
    cwd: process.cwd(),
    signal: new AbortController().signal,
    note: () => undefined,
  };
}

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    into.add(key.toLowerCase());
    collectKeys(child, into);
  }
}

function collectNumbers(value: unknown, into: number[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);
    return;
  }
  if (typeof value === 'number') {
    into.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const child of Object.values(value)) collectNumbers(child, into);
}

/**
 * Assert that a protocol response carries nothing about a credential value:
 * not the value, not a ten-character window of it, not a length, and not a
 * field whose name promises a value.
 */
export function expectNoMaterial(text: string, value: string = CREDENTIAL_VALUE): void {
  expect(text).not.toContain(value);
  for (let start = 0; start + 10 <= value.length; start += 1) {
    expect(text, `a ${10}-character window of the credential value appeared in a client-visible response`).not.toContain(
      value.slice(start, start + 10),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }

  const keys = new Set<string>();
  collectKeys(parsed, keys);
  for (const forbidden of ['value', 'secret', 'credential', 'bytes', 'length', 'prefix', 'preview', 'masked']) {
    expect([...keys], `a response exposed a "${forbidden}" field`).not.toContain(forbidden);
  }

  const numbers: number[] = [];
  collectNumbers(parsed, numbers);
  expect(numbers, 'a response exposed the credential value length').not.toContain(value.length);
}
