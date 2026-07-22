import {
  type AutomationRisk,
  browserAutomationRiskForAction,
} from '@kortix/intelligence-contracts';
import { isSafePublicTarget, matchesAllowedOrigin } from './origin-policy';
import type { PolicyDecision, PolicyInput } from './types';

const DESKTOP_ACTION_RISK_CATALOG: Readonly<Record<string, AutomationRisk>> = Object.freeze({
  'desktop.read_screen': 'observe',
  'desktop.list_windows': 'observe',
  'desktop.mouse': 'operate',
  'desktop.keyboard': 'operate',
  'desktop.window': 'operate',
  'desktop.launch': 'operate',
  'desktop.submit': 'external_effect',
});

function denied(
  code: Extract<PolicyDecision, { allowed: false }>['code'],
  reason: string,
): PolicyDecision {
  return { allowed: false, code, reason };
}

function hasAdministrativeRole(input: PolicyInput): boolean {
  return input.actor.roles.some((role) => role === 'project_admin' || role === 'security_admin');
}

function evaluateBrowserTarget(input: PolicyInput): PolicyDecision | null {
  const browserPolicy = input.job.browser_policy;
  if (!browserPolicy || input.target.origin === null) {
    return denied('SCOPE_DENIED', 'Browser execution requires a browser policy and target');
  }
  if (!isSafePublicTarget(input.target.origin, input.target.resolvedAddresses)) {
    return denied('ORIGIN_DENIED', 'Target or DNS answer is not publicly routable');
  }

  if (browserPolicy.context.mode === 'persistent') {
    if (!input.policy.persistentProfilesAllowed) {
      return denied('FEATURE_DISABLED', 'Persistent browser profiles are disabled');
    }
    if (input.target.profileProjectId !== input.actor.projectId) {
      return denied('SCOPE_DENIED', 'Browser profile is outside the actor project');
    }
  }

  if (browserPolicy.network_mode === 'open') {
    if (!input.policy.openNetworkAllowed) {
      return denied('FEATURE_DISABLED', 'Open networking is disabled by project policy');
    }
    if (!hasAdministrativeRole(input)) {
      return denied('ROLE_DENIED', 'Open networking requires an administrator');
    }
    if (
      browserPolicy.open_network_expires_at === null ||
      Date.parse(browserPolicy.open_network_expires_at) <= input.now.getTime()
    ) {
      return denied('FEATURE_DISABLED', 'Open networking authorization has expired');
    }
    return null;
  }

  if (
    !matchesAllowedOrigin(input.target.origin, browserPolicy.allowed_origins) ||
    !matchesAllowedOrigin(input.target.origin, input.policy.allowedOrigins)
  ) {
    return denied('ORIGIN_DENIED', 'Target origin is not in the project allowlist');
  }
  return null;
}

function evaluateDesktopTarget(input: PolicyInput): PolicyDecision | null {
  const desktopPolicy = input.job.desktop_policy;
  if (
    !desktopPolicy ||
    input.target.deviceId === null ||
    input.target.deviceId !== desktopPolicy.device_id
  ) {
    return denied('SCOPE_DENIED', 'Desktop target is outside the job device scope');
  }
  if (
    input.target.applicationId === null ||
    !desktopPolicy.allowed_applications.includes(input.target.applicationId)
  ) {
    return denied('SCOPE_DENIED', 'Desktop application is outside the job allowlist');
  }
  return null;
}

export function evaluateAutomationPolicy(input: PolicyInput): PolicyDecision {
  if (
    input.actor.accountId !== input.job.tenant_id ||
    input.actor.projectId !== input.job.project_id ||
    !input.job.steps.some(
      (step) => step.step_id === input.step.step_id && step.action_hash === input.step.action_hash,
    )
  ) {
    return denied('SCOPE_DENIED', 'Actor, job, or step scope does not match');
  }

  const risk =
    browserAutomationRiskForAction(input.step.action) ??
    DESKTOP_ACTION_RISK_CATALOG[input.step.action];
  if (!risk) return denied('FEATURE_DISABLED', 'Action is absent from the server catalog');

  const targetDecision =
    input.job.execution_domain === 'browser'
      ? evaluateBrowserTarget(input)
      : evaluateDesktopTarget(input);
  if (targetDecision) return targetDecision;

  const fullAccess = input.job.approval_policy === 'full-access';
  if (fullAccess) {
    if (!input.policy.fullAccessAllowed) {
      return denied('FEATURE_DISABLED', 'Full access is disabled by project policy');
    }
    if (!hasAdministrativeRole(input)) {
      return denied('ROLE_DENIED', 'Full access requires an administrator');
    }
  }

  return {
    allowed: true,
    policyVersion: input.policy.version,
    risk,
    approvalRequired: risk === 'external_effect' || (risk === 'operate' && !fullAccess),
  };
}
