// Public entry point for the AI orchestration layer.
// All LLM calls are gated behind responseNode — other nodes are pure TS/DB.
// Install the SDK before activating: npm install @anthropic-ai/sdk
export { GraphExecutor } from './graph/executor';
export { createState } from './graph/state';
export type { WorkflowState, IntentType } from './graph/state';
export { classifyIntent } from './graph/router';

export { runQuery } from './workflows/queryWorkflow';
export { runReport } from './workflows/reportWorkflow';

export { contextCache } from './cache/contextCache';
