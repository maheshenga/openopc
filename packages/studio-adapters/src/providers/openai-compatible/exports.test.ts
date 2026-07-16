import { describe, expect, test } from 'bun:test';
import { createOpenAiCompatibleImageAdapter, openAiCompatibleImageDefinition } from '../../index';

describe('OpenAI-compatible public exports', () => {
  test('exports the reviewed definition and invocation adapter factory', () => {
    expect(openAiCompatibleImageDefinition.id).toBe('openai-compatible');
    expect(createOpenAiCompatibleImageAdapter).toBeFunction();
  });
});
