// Which run/step a model call belongs to. The engine sets it around each step; ollama.ts reads it,
// so call sites never thread a run id through.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NodeId, RunEvent } from '../types.js';

export interface LlmScope {
  runId: string;
  node: NodeId;
  service?: string;
  emit: (e: RunEvent) => void;
}

export const llmScope = new AsyncLocalStorage<LlmScope>();
