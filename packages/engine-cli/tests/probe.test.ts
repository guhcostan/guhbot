import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '@guhbot/agent';
import { buildCliEnv, createCliEngines, createEngineRegistry, isSecretLikeCliEnvName, type CliEngineOptions } from '../src/index.js';
import { cleanupTempDirs, fakeContext, fixture, installFakeCli, makeTempDir } from './support.js';

/**
 * `probe()` has to be honest about three different states: not installed,
 * installed but broken, and installed and working. It also has to be safe to
 * call at boot for every engine on the machine.
 */

function engineWith(options: CliEngineOptions, id = 'claude-code'): Engine {
  return createEngineRegistry(createCliEngines(options)).require(id);
}

afterEach(() => {
  cleanupTempDirs();
});

describe('engine probe', () => {
  it('reports a missing binary as unavailable instead of throwing', async () => {
    // A real lookup: no such executable exists on this machine, so this exercises
    // the ENOENT path through the real launcher.
    const engine = engineWith({ commands: { 'claude-code': 'guhbot-no-such-cli-4f21' } });

    const probe = await engine.probe();

    expect(probe.available).toBe(false);
    expect(probe.version).toBeNull();
    expect(probe.reason).toContain('guhbot-no-such-cli-4f21');
    expect(probe.reason).toMatch(/not found/i);
    expect(probe.blocked).toBeNull();
  });

  it('reads the version from an installed binary', async () => {
    const engine = engineWith({
      commands: { 'claude-code': installFakeCli() },
      env: { FAKE_CLI_MODE: 'version', FAKE_CLI_VERSION: 'fake-cli 9.9.9' },
    });

    const probe = await engine.probe();

    expect(probe).toEqual({ available: true, version: 'fake-cli 9.9.9', reason: null, blocked: null });
  });

  it('reports an installed binary whose --version fails, without claiming it is missing', async () => {
    const engine = engineWith({
      commands: { 'claude-code': installFakeCli() },
      env: { FAKE_CLI_MODE: 'fail', FAKE_CLI_EXIT: '3', FAKE_CLI_STDERR: 'no such option: --version\n' },
    });

    const probe = await engine.probe();

    expect(probe.available).toBe(true);
    expect(probe.reason).toMatch(/exited with code 3/);
    expect(probe.reason).toContain('no such option: --version');
  });

  it('does not hang when a binary ignores --version', async () => {
    const engine = engineWith(
      {
        commands: { 'claude-code': installFakeCli() },
        env: { FAKE_CLI_MODE: 'hang' },
        probeTimeoutMs: 400,
      },
      'claude-code',
    );

    const probe = await engine.probe();

    expect(probe.available).toBe(true);
    expect(probe.version).toBeNull();
    expect(probe.reason).toMatch(/did not answer/i);
  });

  it('surfaces the last observed rate limit as blocked, and clears it after a good turn', async () => {
    // One engine, one executable, and a stream file that is rewritten between
    // turns: the clearing has to be observed on the same engine or it proves
    // nothing.
    const dir = makeTempDir();
    const stream = join(dir, 'stream.jsonl');
    copyFileSync(fixture('claude-rate-limited.jsonl'), stream);
    const engine = engineWith({
      commands: { 'claude-code': installFakeCli() },
      env: { FAKE_CLI_MODE: 'replay', FAKE_CLI_STREAM: stream },
    });

    expect((await engine.probe()).blocked).toBeNull();

    await engine
      .createExecutor({ cwd: '/tmp' })
      .execute(fakeContext().context, new AbortController().signal)
      .catch(() => undefined);

    // "Installed" and "installed but throttled" need different advice, so the
    // probe reports both rather than collapsing them.
    const blocked = await engine.probe();
    expect(blocked.available).toBe(true);
    expect(blocked.blocked).toMatch(/rate limited/i);
    expect(blocked.blocked).toMatch(/weekly limit/i);

    // A turn that actually produced an answer proves the limit lifted.
    copyFileSync(fixture('claude-success.jsonl'), stream);
    await engine.createExecutor({ cwd: '/tmp' }).execute(fakeContext().context, new AbortController().signal);
    expect((await engine.probe()).blocked).toBeNull();
  });
});

describe('child environment', () => {
  it('filters host secrets by name', () => {
    const env = buildCliEnv(
      undefined,
      { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-x', AWS_SECRET_ACCESS_KEY: 'y', GITHUB_TOKEN: 'z', HOME: '/home/x' },
    );

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/x');
    expect(Object.keys(env)).toEqual(['PATH', 'HOME']);
    expect(isSecretLikeCliEnvName('AWS_REGION')).toBe(true);
    expect(isSecretLikeCliEnvName('OPENAI_API_KEY')).toBe(true);
    expect(isSecretLikeCliEnvName('PATH')).toBe(false);
  });

  it('gives the child an allowlist plus what the caller configured, and nothing else', async () => {
    // The fixture prints its own environment, so this is the child telling us
    // what it actually received rather than what we believe we passed.
    const engine = createEngineRegistry(
      createCliEngines({
        hostEnv: {
          PATH: process.env['PATH'],
          HOME: process.env['HOME'],
          ANTHROPIC_API_KEY: 'sk-ant-do-not-leak',
          OPENAI_API_KEY: 'sk-openai-do-not-leak',
          AWS_SECRET_ACCESS_KEY: 'aws-do-not-leak',
          SOME_HOST_TOKEN: 'token-do-not-leak',
          UNRELATED_VARIABLE: 'not-on-the-allowlist',
        },
        env: { FAKE_CLI_MODE: 'env', GUHBOT_ENGINE_CLI_TEST: 'configured-value' },
        exec: [
          {
            id: 'env-printer',
            name: 'Env Printer',
            requirement: 'test fixture',
            command: installFakeCli(),
            args: ['{prompt}'],
            format: 'text',
          },
        ],
      }),
    ).require('env-printer');

    const recorded = fakeContext();
    await engine.createExecutor({ cwd: '/tmp' }).execute(recorded.context, new AbortController().signal);

    const printed = recorded.entries.find((entry) => entry.kind === 'message')?.content ?? '';
    const childEnv = JSON.parse(printed.trim().replace(/^env /, '')) as Record<string, string>;

    for (const leaked of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'SOME_HOST_TOKEN']) {
      expect(childEnv[leaked]).toBeUndefined();
    }
    expect(childEnv['UNRELATED_VARIABLE']).toBeUndefined();
    expect(childEnv['PATH']).toBe(process.env['PATH']);
    expect(childEnv['GUHBOT_ENGINE_CLI_TEST']).toBe('configured-value');
    expect(printed).not.toContain('do-not-leak');
  });
});
