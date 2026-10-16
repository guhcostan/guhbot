#!/usr/bin/env node
/**
 * A stand-in for an agent CLI.
 *
 * The engines shell out to real programs, so the only honest way to test them
 * without a subscription is to run a real child process: this script is spawned
 * the way `claude` would be, writes real bytes to a real pipe, and dies on real
 * signals. Behavior is selected by environment variables because that is what
 * the tests configure through the engine's own `env` option.
 *
 * Modes:
 *   replay (default)  write FAKE_CLI_STREAM to stdout, optionally in
 *                     FAKE_CLI_CHUNK-sized pieces so a line is split across
 *                     writes, then exit with FAKE_CLI_EXIT
 *   version           print FAKE_CLI_VERSION (for `probe()`)
 *   env               print the child environment as JSON, to prove what leaked
 *   hang              print one line, then never exit (for cancel and timeout)
 *   fail              write FAKE_CLI_STDERR / FAKE_CLI_STDOUT, exit FAKE_CLI_EXIT
 *
 * Every mode records its pid (FAKE_CLI_PID_FILE) and every observed termination
 * signal (FAKE_CLI_SIGNAL_FILE) so a test can assert the engine actually killed
 * it rather than merely stopping to read.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLI_MODE ?? 'replay';
const signalFile = process.env.FAKE_CLI_SIGNAL_FILE ?? '';
const pidFile = process.env.FAKE_CLI_PID_FILE ?? '';

for (const name of ['SIGTERM', 'SIGINT']) {
  process.on(name, () => {
    if (signalFile.length > 0) appendFileSync(signalFile, `${name}\n`);
    // appendFileSync has already reached the disk, so exiting immediately cannot
    // lose the evidence that the signal arrived.
    process.exit(0);
  });
}

// Written only once the handlers above are installed, so the existence of this
// file proves the child is ready to observe a signal. Writing it earlier would
// make a test that waits for it race the child's own startup: a SIGTERM that
// arrives before the handler exists kills the process by default action and
// records nothing.
if (pidFile.length > 0) writeFileSync(pidFile, `${process.pid}\n`);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function* slices(text, size) {
  if (size <= 0) {
    yield text;
    return;
  }
  for (let index = 0; index < text.length; index += size) yield text.slice(index, index + size);
}

if (mode === 'version') {
  process.stdout.write(`${process.env.FAKE_CLI_VERSION ?? 'fake-cli 9.9.9'}\n`);
} else if (mode === 'env') {
  // Prefixed so the line is not itself valid JSON: a driver that parses JSON
  // lines must not mistake the dump for an event.
  process.stdout.write(`env ${JSON.stringify(process.env)}\n`);
} else if (mode === 'hang') {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"fixture"}\n');
  setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  if (process.env.FAKE_CLI_STDERR) process.stderr.write(process.env.FAKE_CLI_STDERR);
  if (process.env.FAKE_CLI_STDOUT) process.stdout.write(process.env.FAKE_CLI_STDOUT);
  process.exitCode = Number(process.env.FAKE_CLI_EXIT ?? '1');
} else {
  const stream = readFileSync(process.env.FAKE_CLI_STREAM, 'utf8');
  const size = Number(process.env.FAKE_CLI_CHUNK ?? '0');
  const delay = Number(process.env.FAKE_CLI_CHUNK_DELAY_MS ?? '1');
  const pieces = [...slices(stream, size)];
  for (const piece of pieces) {
    process.stdout.write(piece);
    if (pieces.length > 1) await sleep(delay);
  }
  process.exitCode = Number(process.env.FAKE_CLI_EXIT ?? '0');
}
