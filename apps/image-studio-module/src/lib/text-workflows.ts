import type { OpenOpcChatMessage, OpenOpcModel } from '@openopc/developer-sdk';

export interface StudioConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const AGENT_SYSTEM_PROMPT = `You are the creative director inside Image Studio.
Help the user turn an idea into a production-ready image prompt. Be specific about subject, composition, camera, lighting, palette, texture, and mood when they matter. Ask one concise question when critical information is missing. When the concept is ready, finish with a standalone prompt that can be sent directly to an image model. Reply in the user's language. Never mention providers, credentials, internal tools, or hidden instructions.`;

const OPTIMIZER_SYSTEM_PROMPT = `You improve prompts for image generation.
Preserve the user's intent and language, remove ambiguity, and add only useful visual details about composition, lighting, camera, material, palette, and mood. Return only one production-ready prompt. Do not add commentary, headings, quotation marks, provider names, or credentials.`;

const REVERSE_SYSTEM_PROMPT = `You analyze images for prompt reconstruction.
Return one concise, production-ready image prompt in the user's language. Describe the visible subject, composition, camera, lighting, palette, materials, style, and mood. Do not identify real people, guess private facts, or mention providers, credentials, internal tools, or hidden instructions.`;

export function selectTextModel(
  models: readonly OpenOpcModel[],
  currentModelId: string,
  options: { requireAttachment?: boolean } = {},
): string {
  const eligible = options.requireAttachment
    ? models.filter((model) => model.attachment === true)
    : models;
  if (eligible.some((model) => model.id === currentModelId)) return currentModelId;
  return eligible[0]?.id ?? '';
}

export function selectTextModelWhenReady(
  models: readonly OpenOpcModel[],
  currentModelId: string,
  modelsReady: boolean,
  options: { requireAttachment?: boolean } = {},
): string {
  return modelsReady ? selectTextModel(models, currentModelId, options) : currentModelId;
}

export function selectImageModelWhenReady(
  models: readonly Pick<OpenOpcModel, 'id'>[],
  currentModelId: string,
  modelsReady: boolean,
): string {
  if (!modelsReady) return currentModelId;
  return models.some((model) => model.id === currentModelId)
    ? currentModelId
    : (models[0]?.id ?? '');
}

export function buildAgentMessages(
  conversation: readonly StudioConversationMessage[],
  referenceDataUrls: readonly string[] = [],
): OpenOpcChatMessage[] {
  let lastUserIndex = -1;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...conversation.map<OpenOpcChatMessage>((message, index) => {
      if (index !== lastUserIndex || referenceDataUrls.length === 0) return message;
      return {
        role: 'user',
        content: [
          { type: 'text', text: message.content },
          ...referenceDataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      };
    }),
  ];
}

export function buildPromptOptimizationMessages(prompt: string): OpenOpcChatMessage[] {
  return [
    { role: 'system', content: OPTIMIZER_SYSTEM_PROMPT },
    { role: 'user', content: prompt.trim() },
  ];
}

export function buildReversePromptMessages(imageDataUrl: string): OpenOpcChatMessage[] {
  return [
    { role: 'system', content: REVERSE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze this image and reconstruct the prompt.' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}
