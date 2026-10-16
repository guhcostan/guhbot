import { describe, expect, it } from 'vitest';
import type { Entry, Run, RunStatus } from '@guhbot/protocol';
import { applyAppended, applyDelta, applyReady, type HostState } from '../src/renderer/api.js';
import { keeperNote, keeperState } from '../src/renderer/App.js';
import keeperAsleep from '../src/renderer/assets/mascot/keeper-asleep.svg';
import keeperBackground from '../src/renderer/assets/mascot/keeper-background.svg';
import keeperPerson from '../src/renderer/assets/mascot/keeper-person.svg';

/**
 * The renderer is a pure mirror: it shows what the host told it and nothing it
 * invented. These tests cover the one piece of state it derives rather than
 * copies — this device's own authority class — because the Keeper mascot is the
 * user-visible face of that class, and getting it wrong tells the human the
 * opposite of the truth about what their own computer is allowed to do.
 */

const IDLE: HostState = {
  status: 'connecting',
  deviceClass: null,
  host: null,
  agents: [],
  activeAgentId: null,
  entries: [],
  runs: {},
  approvals: [],
  error: null,
};

function run(status: RunStatus): Run {
  return {
    id: 'run_1',
    agentId: 'agt_1',
    status,
    promptEntryId: null,
    error: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
  };
}

describe('applyReady', () => {
  it('records the class carried by the ready frame', () => {
    expect(applyReady(IDLE, { deviceId: 'dev_1', deviceClass: 'person' }).deviceClass).toBe('person');
    expect(applyReady(IDLE, { deviceId: 'dev_1', deviceClass: 'background' }).deviceClass).toBe('background');
  });

  it('keeps the previous class when the payload is missing or unrecognised', () => {
    const paired = { ...IDLE, deviceClass: 'person' as const };
    // A host that grows a third class must not make the client claim to be one
    // of the two it already knows about.
    expect(applyReady(paired, { deviceClass: 'superuser' })).toBe(paired);
    expect(applyReady(paired, { deviceId: 'dev_1' })).toBe(paired);
    expect(applyReady(paired, undefined)).toBe(paired);
    expect(applyReady(paired, null)).toBe(paired);
  });

  it('does not disturb the rest of the state', () => {
    const loaded = { ...IDLE, status: 'ready' as const, activeAgentId: 'agt_1' };
    const next = applyReady(loaded, { deviceClass: 'background' });
    expect(next).toMatchObject({ status: 'ready', activeAgentId: 'agt_1', deviceClass: 'background' });
  });
});

/**
 * The thread is assembled from two independent event streams — streamed deltas
 * and durable entries — that can arrive in either order. These tests pin the
 * invariant the human actually sees: one row per sequence, and the durable entry
 * wins.
 */
describe('transcript assembly', () => {
  const active = { ...IDLE, activeAgentId: 'agt_1' };

  function durable(seq: number, content: string, agentId = 'agt_1'): Entry {
    return {
      id: `ent_${seq}`,
      agentId,
      seq,
      runId: 'run_1',
      role: 'agent',
      kind: 'message',
      content,
      toolName: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('replaces the streaming placeholder when the durable entry lands', () => {
    let state = applyDelta(active, { agentId: 'agt_1', seq: 5, textDelta: 'rea' });
    state = applyDelta(state, { agentId: 'agt_1', seq: 5, textDelta: 'dy' });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.content).toBe('ready');
    // Still the placeholder: nothing durable has been written yet.
    expect(state.entries[0]?.id).toMatch(/^pending:/);

    state = applyAppended(state, { entry: durable(5, 'ready') });
    // This is the regression: a second row for the same sequence.
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.id).toBe('ent_5');
    expect(state.entries[0]?.content).toBe('ready');
  });

  it('ignores a late delta once the durable entry is on screen', () => {
    let state = applyAppended(active, { entry: durable(5, 'ready') });
    state = applyDelta(state, { agentId: 'agt_1', seq: 5, textDelta: 'ready' });
    // Replaying a delta onto the durable row would have rendered "readyready".
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.content).toBe('ready');
  });

  it('is idempotent when the same durable entry arrives twice', () => {
    const once = applyAppended(active, { entry: durable(5, 'ready') });
    expect(applyAppended(once, { entry: durable(5, 'ready') })).toBe(once);
  });

  it('keeps the thread ordered by sequence however events interleave', () => {
    let state = applyDelta(active, { agentId: 'agt_1', seq: 7, textDelta: 'second' });
    state = applyAppended(state, { entry: durable(6, 'first') });
    state = applyAppended(state, { entry: durable(7, 'second') });
    expect(state.entries.map((e) => e.seq)).toEqual([6, 7]);
    expect(state.entries.map((e) => e.content)).toEqual(['first', 'second']);
  });

  it('ignores traffic for an agent that is not on screen', () => {
    const other = applyDelta(active, { agentId: 'agt_2', seq: 5, textDelta: 'hidden' });
    expect(other).toBe(active);
    expect(applyAppended(active, { entry: durable(5, 'hidden', 'agt_2') })).toBe(active);
  });
});

/**
 * The three states are a public claim: the landing page advertises both eyes open
 * for a present human, one eye for a device that may only watch, and closed eyes
 * when nothing is running. The app has to agree with the page.
 */
describe('keeper mascot', () => {
  it('closes its eyes when nothing is running, whatever the device is', () => {
    expect(keeperState(null, null)).toBe(keeperAsleep);
    expect(keeperState('person', null)).toBe(keeperAsleep);
    expect(keeperState('background', null)).toBe(keeperAsleep);
    // A finished run is over, and the eyes close again.
    expect(keeperState('person', run('succeeded'))).toBe(keeperAsleep);
    expect(keeperState('person', run('failed'))).toBe(keeperAsleep);
    expect(keeperState('person', run('interrupted'))).toBe(keeperAsleep);
  });

  it('opens both eyes for a person-backed device while a run is in flight', () => {
    expect(keeperState('person', run('queued'))).toBe(keeperPerson);
    expect(keeperState('person', run('running'))).toBe(keeperPerson);
    // Parked on a human decision is still work in flight, and it needs the human.
    expect(keeperState('person', run('waiting-approval'))).toBe(keeperPerson);
  });

  it('shows one eye while a device that may only watch follows a live run', () => {
    expect(keeperState('background', run('running'))).toBe(keeperBackground);
    expect(keeperState('background', run('waiting-approval'))).toBe(keeperBackground);
  });

  it('never implies authority it has not been granted', () => {
    // Before the host says which class this device is, it is not a person.
    expect(keeperState(null, run('running'))).toBe(keeperBackground);
    expect(keeperNote(null, run('running'))).toMatch(/cannot act outward/i);
  });

  it('tells the human what the device may do right now', () => {
    expect(keeperNote('person', null)).toMatch(/nothing is running/i);
    expect(keeperNote('person', run('running'))).toBe('Working.');
    expect(keeperNote('person', run('waiting-approval'))).toMatch(/approval/i);
    expect(keeperNote('background', run('running'))).toMatch(/cannot act outward/i);
  });
});
