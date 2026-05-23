// NOTE: requires @anthropic-ai/sdk — install with: npm install @anthropic-ai/sdk
// This node is the only place in src/ai/ that calls the LLM.
// All other nodes are pure TypeScript / DB reads, keeping LLM usage minimal.
import { SYSTEM_PROMPT } from '../prompts/system';
import { buildUserPrompt } from '../prompts/templates';
import type { WorkflowState } from '../graph/state';

// Lazy-load the SDK so the rest of src/ai/ compiles before it is installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any;
function getClient() {
  if (!_client) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: Anthropic } = require('@anthropic-ai/sdk');
    _client = new Anthropic();
  }
  return _client;
}

export async function responseNode(state: WorkflowState): Promise<WorkflowState> {
  // Short-circuit: if validation already produced errors, no LLM call needed
  if (state.result.validationErrors?.length) {
    state.result.response = state.result.validationErrors.join('\n');
    return state;
  }

  const userPrompt = buildUserPrompt(state);
  const client = getClient();

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', // cheapest — sufficient for structured-data narration
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = message.content?.find((b: { type: string }) => b.type === 'text') as
    | { type: 'text'; text: string }
    | undefined;
  state.result.response = textBlock?.text ?? 'Unable to generate a response.';
  state.meta.tokenUsage.input += message.usage?.input_tokens ?? 0;
  state.meta.tokenUsage.output += message.usage?.output_tokens ?? 0;

  return state;
}
