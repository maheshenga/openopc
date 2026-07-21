import type {
  CapabilityExclusionReason,
  GatewayCapabilityName,
  GatewayCapabilityRequirements,
  ProviderKind,
  UpstreamCapabilityProfile,
  UpstreamCapabilityTransport,
  UpstreamDescriptor,
} from '../domain';

const PROFILE_KEYS = new Set([
  'transport',
  'streaming',
  'imageInput',
  'functionTools',
  'reasoning',
  'stateContinuation',
  'background',
]);

const BOOLEAN_KEYS = [
  'streaming',
  'imageInput',
  'functionTools',
  'reasoning',
  'stateContinuation',
  'background',
] as const;

const REQUIREMENT_MAP = [
  ['streaming', 'streaming'],
  ['imageInput', 'image_input'],
  ['functionTools', 'function_tools'],
  ['reasoning', 'reasoning'],
  ['stateContinuation', 'state_continuation'],
  ['background', 'background'],
] as const;

export type CapabilityEvaluation =
  | { eligible: true; profile: UpstreamCapabilityProfile | null }
  | {
      eligible: false;
      reason: CapabilityExclusionReason;
      capabilities: GatewayCapabilityName[];
    };

function transportForKind(kind: ProviderKind): UpstreamCapabilityTransport {
  return kind === 'openai-responses' ? 'responses' : 'chat-completions';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedProfile(
  descriptor: UpstreamDescriptor,
): UpstreamCapabilityProfile | null | false {
  const raw = descriptor.capabilities;
  if (raw === undefined) return null;
  if (!isObject(raw)) return false;
  if (Object.keys(raw).some((key) => !PROFILE_KEYS.has(key))) return false;
  if (raw.transport !== transportForKind(descriptor.kind)) return false;
  if (BOOLEAN_KEYS.some((key) => key in raw && typeof raw[key] !== 'boolean')) return false;
  return raw as unknown as UpstreamCapabilityProfile;
}

function hasImage(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    if (!isObject(message) || !Array.isArray(message.content)) return false;
    return message.content.some((part) => {
      if (!isObject(part)) return false;
      return part.type === 'image_url' || part.type === 'input_image' || part.type === 'image';
    });
  });
}

export function capabilityRequirementsFromChat(
  body: Record<string, unknown>,
): GatewayCapabilityRequirements {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    imageInput: hasImage(body),
    streaming: body.stream === true,
    functionTools: tools.some((tool) => isObject(tool) && tool.type === 'function'),
    reasoning:
      isObject(body.reasoning) ||
      typeof body.reasoning_effort === 'string' ||
      isObject(body.thinking),
    stateContinuation: false,
    background: false,
  };
}

export function requiredCapabilityNames(
  requirements: GatewayCapabilityRequirements,
): GatewayCapabilityName[] {
  return REQUIREMENT_MAP.flatMap(([field, name]) => (requirements[field] ? [name] : []));
}

export function evaluateUpstreamCapabilities(
  descriptor: UpstreamDescriptor,
  requirements: GatewayCapabilityRequirements,
): CapabilityEvaluation {
  const profile = normalizedProfile(descriptor);
  if (profile === false) {
    return { eligible: false, reason: 'PROFILE_INVALID', capabilities: [] };
  }
  if (profile === null) return { eligible: true, profile: null };
  const capabilities = REQUIREMENT_MAP.flatMap(([field, name]) =>
    requirements[field] && profile[field] === false ? [name] : [],
  );
  return capabilities.length > 0
    ? { eligible: false, reason: 'CAPABILITY_UNSUPPORTED', capabilities }
    : { eligible: true, profile };
}
