import type {
  AutomationJobRequest,
  AutomationRisk,
  AutomationStep,
} from '@kortix/intelligence-contracts';
import type { AutomationActor } from '../repository';

export type PolicyInput = Readonly<{
  actor: AutomationActor;
  job: AutomationJobRequest;
  step: AutomationStep;
  policy: {
    version: string;
    allowedOrigins: readonly string[];
    openNetworkAllowed: boolean;
    persistentProfilesAllowed: boolean;
    fullAccessAllowed: boolean;
  };
  target: {
    origin: string | null;
    resolvedAddresses: readonly string[];
    deviceId: string | null;
    applicationId: string | null;
    profileProjectId?: string | null;
  };
  now: Date;
}>;

export type PolicyDecision =
  | {
      allowed: true;
      policyVersion: string;
      risk: AutomationRisk;
      approvalRequired: boolean;
    }
  | {
      allowed: false;
      code: 'ORIGIN_DENIED' | 'SCOPE_DENIED' | 'ROLE_DENIED' | 'FEATURE_DISABLED';
      reason: string;
    };
