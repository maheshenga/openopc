export const DEVELOPER_TRUST_READINESS_COMPONENTS = [
  'objectStorage',
  'postgresClaims',
  'policy',
  'gitleaks',
  'syft',
  'osv',
  'semgrep',
  'licensePolicy',
  'attestationSigner',
  'sandboxControl',
] as const;

export type DeveloperTrustReadinessComponentName =
  (typeof DEVELOPER_TRUST_READINESS_COMPONENTS)[number];
export type DeveloperTrustReadinessReason =
  | 'ready'
  | 'disabled'
  | 'unavailable'
  | 'invalid'
  | 'identity_mismatch'
  | 'not_configured';

export interface DeveloperTrustReadinessComponent {
  ready: boolean;
  reason: DeveloperTrustReadinessReason;
}

export interface DeveloperTrustReadiness {
  enabled: boolean;
  ready: boolean;
  components: Record<DeveloperTrustReadinessComponentName, DeveloperTrustReadinessComponent>;
}

type ProbeResult = undefined | { ready: false; reason: DeveloperTrustReadinessReason };
type ComponentProbe = {
  probe(): Promise<ProbeResult>;
  unavailableReason?: Exclude<DeveloperTrustReadinessReason, 'ready' | 'disabled'>;
};

export interface DeveloperTrustReadinessInput {
  enabled: boolean;
  components: Record<DeveloperTrustReadinessComponentName, ComponentProbe>;
}

async function runProbe(input: ComponentProbe): Promise<DeveloperTrustReadinessComponent> {
  try {
    const result = await input.probe();
    return result?.ready === false ? result : { ready: true, reason: 'ready' };
  } catch {
    return { ready: false, reason: input.unavailableReason ?? 'unavailable' };
  }
}

export function createDeveloperTrustReadiness(input: DeveloperTrustReadinessInput): {
  check(): Promise<DeveloperTrustReadiness>;
} {
  return {
    async check() {
      if (!input.enabled) {
        return {
          enabled: false,
          ready: false,
          components: Object.fromEntries(
            DEVELOPER_TRUST_READINESS_COMPONENTS.map((name) => [
              name,
              { ready: false, reason: 'disabled' },
            ]),
          ) as DeveloperTrustReadiness['components'],
        };
      }
      const entries = await Promise.all(
        DEVELOPER_TRUST_READINESS_COMPONENTS.map(
          async (name) => [name, await runProbe(input.components[name])] as const,
        ),
      );
      const components = Object.fromEntries(entries) as DeveloperTrustReadiness['components'];
      return {
        enabled: true,
        ready: Object.values(components).every((component) => component.ready),
        components,
      };
    },
  };
}
