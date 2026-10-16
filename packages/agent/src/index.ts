/**
 * @guhbot/agent — the model-facing half of the host.
 *
 * Depends on `@guhbot/host-core` only for the `RunExecutor`/`RunContext` seam it
 * implements. Nothing here knows about transports or clients.
 */
export { AgentLoop } from './loop.js';
export type { LoopOptions, LoopResult } from './loop.js';

export { ProviderError, parseSse, withRetry } from './provider.js';
export type { ModelEvent, ModelProvider, ModelRequest, StopReason } from './provider.js';

export { OpenAiCompatibleProvider } from './providers/openai-compatible.js';
export type { OpenAiCompatibleOptions } from './providers/openai-compatible.js';

export { ToolRegistry } from './types.js';
export type {
  ChatMessage,
  ContentPart,
  ImagePart,
  Role,
  TextPart,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
} from './types.js';

export { builtinTools, resolveInside } from './tools/builtin.js';
export { assertCapability, collectContributions, prepareCapabilities } from './capability.js';
export { classifyCliFailure, readJsonLines } from './engine.js';
export type { CliChild, CliSpawn, Engine, EngineDescriptor, EngineProbe, EngineRunOptions } from './engine.js';
export type { Capability } from './capability.js';
export type { BuiltinToolOptions } from './tools/builtin.js';
