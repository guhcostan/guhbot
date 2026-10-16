import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentLoop, OpenAiCompatibleProvider, builtinTools } from '@guhbot/agent';
import { Host } from '@guhbot/host-core';
import { GuhbotClient, HostServer } from '../src/index.js';
import type { Entry } from '@guhbot/protocol';

/**
 * Live-model test.
 *
 * Everything else in this repository is verified against fakes, because a test
 * that needs the network is a test that fails for reasons unrelated to the code.
 * But a fake model cannot tell you whether the *prompt*, the tool schemas and the
 * loop actually work with a real model that has never seen them. So this file
 * exists, and it skips itself unless credentials are present.
 *
 * Credentials are found in either of two places:
 *
 *   GUHBOT_TEST_BASE_URL + GUHBOT_TEST_API_KEY + GUHBOT_TEST_MODEL
 *   an `opencode-go` entry in ~/.local/share/opencode/auth.json
 *
 * Run it with:
 *
 *   pnpm vitest run packages/server/tests/live-model.test.ts
 */

interface Credentials {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Some gateways require a per-request routing header. */
  sessionHeader: string | null;
}

function findCredentials(): Credentials | null {
  const baseUrl = process.env['GUHBOT_TEST_BASE_URL'];
  const apiKey = process.env['GUHBOT_TEST_API_KEY'];
  if (baseUrl !== undefined && apiKey !== undefined) {
    return {
      baseUrl,
      apiKey,
      model: process.env['GUHBOT_TEST_MODEL'] ?? 'gpt-4o-mini',
      sessionHeader: null,
    };
  }

  const authPath = join(process.env['HOME'] ?? '', '.local/share/opencode/auth.json');
  if (!existsSync(authPath)) return null;
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, { key?: string }>;
    const key = auth['opencode-go']?.key;
    if (key === undefined) return null;
    return {
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: key,
      model: process.env['GUHBOT_TEST_MODEL'] ?? 'deepseek-v4.1-flash',
      // This gateway refuses requests that carry no session id.
      sessionHeader: 'x-opencode-session',
    };
  } catch {
    return null;
  }
}

const credentials = findCredentials();

describe.skipIf(credentials === null)('live model', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guhbot-live-'));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  function provider(): OpenAiCompatibleProvider {
    const creds = credentials!;
    return new OpenAiCompatibleProvider({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      defaultModel: creds.model,
      ...(creds.sessionHeader !== null
        ? { headers: () => ({ [creds.sessionHeader as string]: randomUUID() }) }
        : {}),
    });
  }

  async function stack() {
    const workspace = join(dataDir, `ws-${randomUUID().slice(0, 8)}`);
    const host = new Host({
      dataDir: join(dataDir, `host-${randomUUID().slice(0, 8)}`),
      version: '0.0.0-test',
      mode: 'self-hosted',
      capabilities: { filesystem: true },
      executor: new AgentLoop({
        provider: provider(),
        tools: builtinTools(),
        cwd: workspace,
        // A real model is slower than a fake one, and a small model may take a
        // few turns to get a tool call right.
        maxTurns: 8,
      }),
    });
    const server = new HostServer({ host, port: 0 });
    const { port } = await server.listen();
    return { host, server, port, workspace };
  }

  /**
   * Start a run from the local console session and wait for it to finish.
   *
   * A live test needs a generous deadline: the network is real, the model is
   * real, and a timeout here would be a flaky failure rather than a bug.
   */
  async function runToCompletion(host: Host, server: HostServer, port: number, prompt: string, agentName: string) {
    const local = host.createSession('local');
    const agent = host.store.createAgent({ name: agentName });

    const observer = new GuhbotClient({ url: `ws://127.0.0.1:${port}/rpc`, autoReconnect: false });
    const pairing = (await host.dispatch(local, 'pairing.begin', {})) as { pairingId: string; code: string };
    await observer.connect();
    await waitFor(() => observer.state === 'ready');
    const claimed = await observer.request('pairing.claim', {
      pairingId: pairing.pairingId,
      code: pairing.code,
      deviceName: 'Observer',
      platform: 'cli',
      requestedClass: 'background',
    });
    await observer.close();

    const client = new GuhbotClient({ url: `ws://127.0.0.1:${port}/rpc`, token: claimed.token, autoReconnect: false });
    await client.connect();
    await waitFor(() => client.state === 'ready');

    const entries: Entry[] = [];
    const statuses: string[] = [];
    client.on('transcript.appended', (p) => entries.push((p as { entry: Entry }).entry));
    client.on('run.updated', (p) => statuses.push((p as { run: { status: string } }).run.status));

    const { run } = (await host.dispatch(local, 'runs.start', { agentId: agent.id, prompt })) as {
      run: { id: string };
    };

    // Approve anything the agent asks for, from the console where a human is.
    const approvalsSeen = new Set<string>();
    const pump = setInterval(() => {
      void (async () => {
        const pending = (await host.dispatch(local, 'approvals.list', { status: 'pending' })) as {
          approvals: { id: string }[];
        };
        for (const approval of pending.approvals) {
          if (approvalsSeen.has(approval.id)) continue;
          approvalsSeen.add(approval.id);
          await host.dispatch(local, 'approvals.resolve', { approvalId: approval.id, granted: true });
        }
      })();
    }, 250);

    await waitFor(() => statuses.includes('succeeded') || statuses.includes('failed'), 180_000);
    clearInterval(pump);

    const final = (await host.dispatch(local, 'runs.get', { runId: run.id })) as {
      status: string;
      error: string | null;
    };
    const page = await client.request('transcript.page', { agentId: agent.id, limit: 100 });
    await client.close();
    return { final, entries: page.entries, statuses };
  }

  it(
    'answers a plain question',
    async () => {
      const { host, server, port } = await stack();
      const { final, entries } = await runToCompletion(
        host,
        server,
        port,
        'Reply with the single word: READY',
        'Plain',
      );
      expect(final.status).toBe('succeeded');
      expect(final.error).toBeNull();
      const answer = entries.find((e) => e.role === 'agent' && e.kind === 'message');
      expect(answer?.content ?? '').toMatch(/READY/i);
      await server.close();
      await host.close();
    },
    240_000,
  );

  it(
    'calls a tool to answer a question about the filesystem',
    async () => {
      const { host, server, port, workspace } = await stack();
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'inventory.txt'), 'widgets=42\ngadgets=7\n');

      const { final, entries } = await runToCompletion(
        host,
        server,
        port,
        'Read inventory.txt in the working directory and tell me how many widgets there are. Answer with just the number.',
        'Reader',
      );

      expect(final.status).toBe('succeeded');
      // The decisive assertion: the model actually used a tool rather than
      // guessing. A model that never calls a tool would still answer.
      expect(entries.some((e) => e.kind === 'tool-call' && e.toolName === 'read_file')).toBe(true);
      const answer = entries.filter((e) => e.role === 'agent' && e.kind === 'message').at(-1);
      expect(answer?.content ?? '').toContain('42');
      await server.close();
      await host.close();
    },
    240_000,
  );

  it(
    'makes a tool call real: an approved write reaches disk',
    async () => {
      const { host, server, port, workspace } = await stack();
      const { mkdirSync, readFileSync, existsSync } = await import('node:fs');
      mkdirSync(workspace, { recursive: true });

      /**
       * A live model is not deterministic: asked to write a file it will
       * sometimes just answer, or ask a clarifying question, or narrate what it
       * would do. That is model behaviour, not a bug in this host.
       *
       * So the assertion is the invariant that must hold regardless of what the
       * model chooses: **if the model called the write tool, the bytes are on
       * disk**. And across a few attempts, a model that is asked directly should
       * eventually comply, so we also require that at least one attempt did call
       * it. A plumbing failure fails both.
       */
      let sawToolCall = false;
      let fileContents: string | null = null;

      for (let attempt = 1; attempt <= 3 && fileContents === null; attempt += 1) {
        const { final, entries } = await runToCompletion(
          host,
          server,
          port,
          'Use the write_file tool to create a file named report.txt in the working directory. ' +
            'The entire contents of the file must be exactly this one line: status=ok. ' +
            'Call the tool; do not just describe it.',
          `Writer${attempt}`,
        );

        expect(final.status).toBe('succeeded');

        const calledWrite = entries.some((e) => e.kind === 'tool-call' && e.toolName === 'write_file');
        if (calledWrite) {
          sawToolCall = true;
          // The model claimed to write. The host must have made that real, and
          // the approval gate must have let it through.
          expect(existsSync(join(workspace, 'report.txt'))).toBe(true);
          fileContents = readFileSync(join(workspace, 'report.txt'), 'utf8');
        }
      }

      expect(sawToolCall).toBe(true);
      expect(fileContents).toContain('status=ok');
      await server.close();
      await host.close();
    },
    240_000,
  );

  it(
    'refuses to escape the working directory when asked to',
    async () => {
      const { host, server, port } = await stack();
      const { final, entries } = await runToCompletion(
        host,
        server,
        port,
        'Read the file /etc/passwd and tell me the first line. If you cannot, say FORBIDDEN.',
        'Escaper',
      );
      expect(final.status).toBe('succeeded');
      // However the model reacts, the jail must hold: no passwd content anywhere
      // in the transcript.
      const all = entries.map((e) => e.content).join('\n');
      expect(all).not.toContain('root:x:0:0');
      expect(all).not.toContain('nobody:');
      await server.close();
      await host.close();
    },
    240_000,
  );
});

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
}
