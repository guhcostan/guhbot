import type { MemoryStore } from './store.js';

/**
 * Which agent is calling a memory tool?
 *
 * This is the hard part of an agent-scoped tool, and it is a gap in the platform
 * rather than a choice made here: `ToolExecutionContext` carries no agent
 * identity and `AgentLoop` is constructed once with a flat tool list, so a tool
 * cannot be told whose run it is inside. The scheduler capability hit the same
 * wall and documented its own resolution order; this is the memory version.
 *
 * The order is deliberate, and every rung is safe rather than convenient:
 *
 *  1. **A bound agent.** A host that runs one agent per capability instance says
 *     so at construction and the question never comes up.
 *  2. **Runs in flight.** A tool call only happens inside a run, so if every run
 *     that has not finished belongs to one agent, that agent is the caller's.
 *     Runs spanning several agents is ambiguous and refuses.
 *  3. **The only agent on the host.** With one agent, every run belongs to it, so
 *     this cannot attribute a call to the wrong agent.
 *  4. **Refuse.** The model is told how many agents and runs exist, and that the
 *     capability must be bound. Guessing here would be a memory leak between
 *     agents, which is the one thing this capability must never do.
 *
 * Notably absent: an `agentId` argument. A model that could name the agent could
 * be talked into naming a different one by a page it read, and "one agent's
 * memory never appears in another's recall" would stop being true.
 */
export function createAgentResolver(store: MemoryStore, boundAgentId: string | null): () => string {
  const trimmed = boundAgentId?.trim();
  const bound = trimmed !== undefined && trimmed.length > 0 ? trimmed : null;

  return () => {
    if (bound !== null) {
      if (!store.hasAgent(bound)) {
        throw new Error(`the memory capability is bound to agent ${bound}, which no longer exists on this host`);
      }
      return bound;
    }

    const inFlight = new Set(store.agentsWithRunsInFlight());
    if (inFlight.size === 1) {
      const agentId = [...inFlight][0]!;
      if (!store.hasAgent(agentId)) {
        throw new Error(`the run in flight belongs to agent ${agentId}, which no longer exists on this host`);
      }
      return agentId;
    }

    const agents = store.agentIds();
    if (inFlight.size === 0 && agents.length === 1) return agents[0]!;

    throw new Error(
      `the memory tools cannot tell which agent is calling: this host has ${agents.length} agents and ` +
        `${inFlight.size} of them with runs in flight. Bind the capability to one agent ` +
        '(createMemoryCapability({ agentId })).',
    );
  };
}
