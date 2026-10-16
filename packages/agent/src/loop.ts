import type { Entry } from '@guhbot/protocol';
import type { RunContext, RunExecutor } from '@guhbot/host-core';
import type { ChatMessage, ToolCall, ToolDefinition, ToolExecutionContext } from './types.js';
import type { ModelProvider } from './provider.js';
import { ProviderError } from './provider.js';

/**
 * The agent loop.
 *
 * Responsibilities, in order of importance:
 *
 *  1. **Make every model action visible.** Anything the model says, any tool it
 *     calls and any result that comes back becomes a transcript entry. A run the
 *     user cannot audit is worse than a run that failed.
 *  2. **Stop.** A bounded number of model turns, a bounded number of tool calls
 *     per turn, and a token budget. An agent that can loop forever will.
 *  3. **Escalate instead of guessing.** A tool marked `requiresApproval` parks
 *     the run on a human decision rather than proceeding.
 *
 * The loop is deliberately not a graph engine or a planner. Providers are now
 * good at deciding the next step; the valuable engineering is the guardrails,
 * the transcript and the approval seam around them.
 */

export interface LoopOptions {
  provider: ModelProvider;
  tools: ToolDefinition[];
  /** Working directory handed to filesystem-scoped tools. */
  cwd: string;
  /** Upper bound on model turns in a single run. */
  maxTurns?: number;
  /** Upper bound on sequential tool executions in a single run. */
  maxToolCalls?: number;
  maxTokensPerTurn?: number;
  temperature?: number;
  /**
   * Extra system-prompt text contributed by capabilities, each returning a
   * block or null for nothing.
   *
   * Read once per run, when the prompt is assembled — not once per turn. A
   * capability may write while answering (memory marks a recalled fact as used),
   * so calling it inside the turn loop would mean a durable write per model turn.
   */
  contextSections?: readonly ((context: RunContext) => string | null)[];
  /** Called for every provider request, for tests and tracing. */
  onRequest?: (messages: ChatMessage[]) => void;
  now?: () => number;
}

export interface LoopResult {
  turns: number;
  toolCalls: number;
  stopReason: 'completed' | 'max-turns' | 'max-tool-calls' | 'cancelled' | 'error';
  error?: string;
}

export class AgentLoop implements RunExecutor {
  private readonly options: LoopOptions;

  constructor(options: LoopOptions) {
    this.options = options;
  }

  async execute(context: RunContext, signal: AbortSignal): Promise<void> {
    const result = await this.run(context, signal);
    if (result.stopReason === 'error' && result.error !== undefined) {
      // Surfacing the reason as a transcript entry means the failure is visible
      // in the client, not just in a host log the user will never read.
      context.append({ role: 'system', kind: 'error', content: result.error });
      throw new Error(result.error);
    }
    if (result.stopReason === 'max-turns' || result.stopReason === 'max-tool-calls') {
      context.append({
        role: 'system',
        kind: 'status',
        content: `Stopped after ${result.turns} turns and ${result.toolCalls} tool calls (${result.stopReason}). Raise the limit or narrow the task to continue.`,
      });
    }
  }

  private async run(context: RunContext, signal: AbortSignal): Promise<LoopResult> {
    const maxTurns = this.options.maxTurns ?? 24;
    const maxToolCalls = this.options.maxToolCalls ?? 64;
    const messages = this.buildInitialMessages(context);
    // Built once, outside the loop: nothing in it varies between turns, and a
    // capability's section may write when it answers.
    const system = this.systemPrompt(context);

    let turns = 0;
    let toolCalls = 0;

    while (turns < maxTurns) {
      if (signal.aborted || context.isCancelled()) {
        return { turns, toolCalls, stopReason: 'cancelled' };
      }
      turns += 1;
      this.options.onRequest?.(messages);

      let assistantText = '';
      let assistantReasoning = '';
      const requested: ToolCall[] = [];
      let stopReason: string | null = null;
      let errorText: string | null = null;

      try {
        for await (const event of this.options.provider.stream({
          model: context.agent.model ?? this.options.provider.defaultModel,
          messages,
          tools: this.options.tools,
          system,
          maxTokens: this.options.maxTokensPerTurn ?? 8192,
          temperature: this.options.temperature ?? 0.2,
          signal,
        })) {
          if (signal.aborted) return { turns, toolCalls, stopReason: 'cancelled' };

          if (event.type === 'text-delta') {
            assistantText += event.text;
            // Ephemeral: the client renders this immediately, and the durable
            // entry is written once below.
            context.emitDelta(context.history.length + turns - 1, event.text);
          } else if (event.type === 'reasoning-delta') {
            // Kept out of the transcript on purpose: it is provider transport
            // state, not something the user asked to see, and it is large.
            assistantReasoning += event.text;
          } else if (event.type === 'tool-call') {
            requested.push(event.call);
          } else if (event.type === 'stop') {
            stopReason = event.reason;
            if (event.error !== undefined) errorText = event.error;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          turns,
          toolCalls,
          stopReason: 'error',
          error:
            error instanceof ProviderError && !error.retryable
              ? `model request was rejected: ${message}`
              : `model request failed: ${message}`,
        };
      }

      if (assistantText.trim().length > 0) {
        context.append({ role: 'agent', kind: 'message', content: assistantText });
      }

      if (stopReason === 'error') {
        return { turns, toolCalls, stopReason: 'error', error: errorText ?? 'the model stopped with an error' };
      }
      if (stopReason === 'length') {
        context.append({
          role: 'system',
          kind: 'status',
          content: 'The model hit its output limit for this turn. Increase maxTokensPerTurn or ask for a smaller step.',
        });
        return { turns, toolCalls, stopReason: 'completed' };
      }
      if (requested.length === 0) {
        return { turns, toolCalls, stopReason: 'completed' };
      }

      // Record the assistant's tool requests before running them, so the
      // transcript shows intent even if the process dies mid-call.
      for (const call of requested) {
        context.append({
          role: 'agent',
          kind: 'tool-call',
          content: call.rawArguments.length > 0 ? call.rawArguments : '{}',
          toolName: call.name,
        });
      }

      const results: ChatMessage[] = [];
      for (const call of requested) {
        if (signal.aborted || context.isCancelled()) {
          return { turns, toolCalls, stopReason: 'cancelled' };
        }
        if (toolCalls >= maxToolCalls) {
          return { turns, toolCalls, stopReason: 'max-tool-calls' };
        }
        toolCalls += 1;

        const toolResult = await this.executeTool(call, context, signal);
        context.append({
          role: 'tool',
          kind: 'tool-result',
          content: toolResult,
          toolName: call.name,
        });
        results.push({ role: 'tool', content: toolResult, toolCallId: call.id });
      }

      // Feed the turn back to the model. The assistant message has to carry the
      // tool_calls the results answer, or providers reject the request.
      messages.push({
        role: 'assistant',
        content: assistantText,
        toolCalls: requested,
        ...(assistantReasoning.length > 0 ? { reasoning: assistantReasoning } : {}),
      });
      messages.push(...results);
    }

    return { turns, toolCalls, stopReason: 'max-turns' };
  }

  /**
   * Run one tool, escalating to a human when the tool asks for it.
   *
   * A denied or expired approval is returned to the model as a normal tool
   * result. That is intentional: the model should learn the call was refused and
   * choose another path, rather than the run dying.
   */
  private async executeTool(call: ToolCall, context: RunContext, signal: AbortSignal): Promise<string> {
    const tool = this.options.tools.find((t) => t.name === call.name);
    if (!tool) {
      const available = this.options.tools.map((t) => t.name).sort().join(', ');
      return `Error: no tool named "${call.name}". Available tools: ${available || 'none'}.`;
    }

    if (call.parseError !== null) {
      return `Error: the arguments for "${call.name}" were not valid JSON (${call.parseError}). Re-issue the call with valid JSON.`;
    }

    if (tool.requiresApproval) {
      const approval = await context.requestApproval({
        kind: 'tool-permission',
        summary: `Run ${tool.name}?`,
        detail: JSON.stringify({ tool: tool.name, arguments: call.arguments }, null, 2),
        ttlSeconds: 3600,
      });
      if (approval.status !== 'granted') {
        return `Refused: the user did not approve "${tool.name}" (status: ${approval.status}). Do not retry this call.`;
      }
    }

    const toolContext: ToolExecutionContext = {
      readSecret: context.readSecret,
      cwd: this.options.cwd,
      signal,
      note: (message) => {
        context.append({ role: 'system', kind: 'status', content: message });
      },
    };

    try {
      const output = await tool.execute(call.arguments, toolContext);
      return output.length > 0 ? output : '(the tool returned no output)';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Tool failures are data for the model, not fatal for the run.
      return `Error: ${tool.name} failed: ${message}`;
    }
  }

  /**
   * Turn stored transcript entries into chat messages.
   *
   * Tool results and approvals are rendered as text rather than as native
   * tool-result blocks, because the earlier turns may have been produced by a
   * different provider whose call ids no longer exist. Flattening keeps a
   * resumed conversation portable across providers.
   */
  private buildInitialMessages(context: RunContext): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const entry of context.history) {
      const text = renderEntry(entry);
      if (text === null) continue;
      switch (entry.role) {
        case 'user':
          messages.push({ role: 'user', content: text });
          break;
        case 'agent':
          messages.push({ role: 'assistant', content: text });
          break;
        case 'tool':
          messages.push({ role: 'user', content: `Tool ${entry.toolName ?? 'result'} returned:\n${text}` });
          break;
        case 'system':
          messages.push({ role: 'user', content: `[system] ${text}` });
          break;
      }
    }
    // The prompt for this run is already the last history entry, but guard
    // against a caller that passed an empty history.
    if (messages.length === 0) {
      messages.push({ role: 'user', content: context.prompt });
    }
    return messages;
  }

  private systemPrompt(context: RunContext): string {
    const toolNames = this.options.tools.map((t) => t.name).sort();
    const lines = [
      'You are a worker agent running inside a host that a person has given you access to.',
      'You act by calling tools. Prefer doing the work over describing what you would do.',
      'When you need information you do not have, call a tool rather than assuming.',
      'When the task is finished, reply with a short summary of what you did and what changed.',
      '',
      `Working directory: ${this.options.cwd}`,
    ];
    if (toolNames.length > 0) {
      lines.push(`Available tools: ${toolNames.join(', ')}`);
    }
    const instructions = context.agent.instructions.trim();
    if (instructions.length > 0) {
      lines.push('', 'Your operating instructions from the user:', instructions);
    }
    // Capability sections come last, and each is framed by the capability that
    // produced it. A section that throws is dropped rather than failing the run:
    // a capability's extra context is an enhancement, and losing it is not a
    // reason to refuse work the user asked for.
    for (const section of this.options.contextSections ?? []) {
      let text: string | null = null;
      try {
        text = section(context);
      } catch {
        text = null;
      }
      const trimmed = text?.trim() ?? '';
      if (trimmed.length > 0) lines.push('', trimmed);
    }
    return lines.join('\n');
  }
}

/** Render a stored entry as plain text for the model, or null to skip it. */
function renderEntry(entry: Entry): string | null {
  switch (entry.kind) {
    case 'message':
    case 'tool-result':
    case 'error':
    case 'status':
      return entry.content;
    case 'tool-call':
      return `[called ${entry.toolName ?? 'tool'} with ${entry.content}]`;
    case 'approval-request':
      return `[requested approval: ${entry.content}]`;
    case 'approval-resolution':
      return `[approval resolved: ${entry.content}]`;
    case 'artifact':
      return `[produced artifact: ${entry.content}]`;
    default:
      return null;
  }
}
