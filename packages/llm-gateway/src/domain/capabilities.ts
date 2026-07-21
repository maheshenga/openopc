export type UpstreamCapabilityTransport = 'chat-completions' | 'responses';

export type GatewayCapabilityName =
  | 'streaming'
  | 'image_input'
  | 'function_tools'
  | 'reasoning'
  | 'state_continuation'
  | 'background';

export type CapabilityExclusionReason = 'CAPABILITY_UNSUPPORTED' | 'PROFILE_INVALID';

export interface UpstreamCapabilityProfile {
  transport: UpstreamCapabilityTransport;
  streaming?: boolean;
  imageInput?: boolean;
  functionTools?: boolean;
  reasoning?: boolean;
  stateContinuation?: boolean;
  background?: boolean;
}

export interface GatewayCapabilityRequirements {
  imageInput: boolean;
  streaming?: boolean;
  functionTools?: boolean;
  reasoning?: boolean;
  stateContinuation?: boolean;
  background?: boolean;
}
