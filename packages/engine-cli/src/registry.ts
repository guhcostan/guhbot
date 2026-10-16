import type { Engine, EngineDescriptor, EngineProbe } from '@guhbot/agent';
import { createCliEngines } from './engines.js';

/**
 * The engine registry.
 *
 * A host needs two things from a list of engines: to show the user what is
 * available (with the honest result of probing it) and to turn a configured id
 * into the engine that id names. The second must fail with the list of ids,
 * because "unknown engine" with no alternatives is a dead end for whoever is
 * editing the configuration.
 */

export interface EngineStatus extends EngineDescriptor {
  readonly probe: EngineProbe;
}

export interface EngineRegistry {
  /** Configured ids, in registration order. */
  ids(): string[];
  /** Descriptors only. Never touches a child process. */
  list(): EngineDescriptor[];
  get(id: string): Engine | undefined;
  /** Resolve an id or throw, naming everything that would have worked. */
  require(id: string): Engine;
  /** Probe every engine, in parallel. Never rejects. */
  probe(): Promise<EngineStatus[]>;
}

/**
 * Build a registry. With no argument it registers everything this package
 * ships; construction never probes or spawns anything, so this is cheap.
 */
export function createEngineRegistry(engines: Engine[] = createCliEngines()): EngineRegistry {
  const byId = new Map<string, Engine>();
  for (const engine of engines) {
    // A duplicate id would make `require` return whichever engine happened to
    // win, which is exactly the kind of silent ambiguity the host refuses
    // elsewhere for capability names.
    if (byId.has(engine.id)) throw new Error(`two engines share the id "${engine.id}"; engine ids must be unique`);
    byId.set(engine.id, engine);
  }

  const ids = [...byId.keys()];

  const unknown = (id: string): Error =>
    new Error(`no engine is configured with the id "${id}". Available engines: ${ids.length > 0 ? ids.join(', ') : '(none)'}.`);

  return {
    ids: () => [...ids],

    list: () => engines.map(({ id, name, requirement }) => ({ id, name, requirement })),

    get: (id) => byId.get(id),

    require: (id) => {
      const engine = byId.get(id);
      if (engine === undefined) throw unknown(id);
      return engine;
    },

    probe: async () =>
      Promise.all(
        engines.map(async (engine) => ({
          id: engine.id,
          name: engine.name,
          requirement: engine.requirement,
          probe: await probeSafely(engine),
        })),
      ),
  };
}

/**
 * Probe one engine without letting it take the status list down.
 *
 * `Engine.probe` is documented not to throw for a missing binary, but a caller
 * can hand the registry any `Engine`, including one whose probe throws. A status
 * surface has to render either way.
 */
async function probeSafely(engine: Engine): Promise<EngineProbe> {
  try {
    return await engine.probe();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, version: null, reason: `the probe failed: ${detail}`, blocked: null };
  }
}
