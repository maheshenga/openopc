export type DeveloperTrustScannerReadiness =
  | 'ready'
  | 'unavailable'
  | 'identity_mismatch'
  | 'disabled';

export interface DeveloperTrustReadiness {
  enabled: boolean;
  ready: boolean;
  artifactStore: 'ready' | 'unavailable' | 'disabled';
  policy: 'ready' | 'invalid' | 'disabled';
  scanners: Record<string, DeveloperTrustScannerReadiness>;
  sandbox: 'ready' | 'unavailable' | 'disabled';
  databaseClaims: 'ready' | 'unavailable' | 'disabled';
}

type AvailabilityProbe = () => Promise<void>;
type ScannerProbe = () => Promise<'ready' | 'identity_mismatch' | void>;

export interface DeveloperTrustReadinessInput {
  enabled: boolean;
  artifactStore: AvailabilityProbe;
  policy: AvailabilityProbe;
  scanners: Readonly<Record<string, ScannerProbe>>;
  sandbox: AvailabilityProbe;
  databaseClaims: AvailabilityProbe;
}

async function availability(probe: AvailabilityProbe): Promise<'ready' | 'unavailable'> {
  try {
    await probe();
    return 'ready';
  } catch {
    return 'unavailable';
  }
}

async function policyAvailability(probe: AvailabilityProbe): Promise<'ready' | 'invalid'> {
  try {
    await probe();
    return 'ready';
  } catch {
    return 'invalid';
  }
}

async function scannerAvailability(probe: ScannerProbe): Promise<DeveloperTrustScannerReadiness> {
  try {
    return (await probe()) === 'identity_mismatch' ? 'identity_mismatch' : 'ready';
  } catch {
    return 'unavailable';
  }
}

export function createDeveloperTrustReadiness(input: DeveloperTrustReadinessInput): {
  check(): Promise<DeveloperTrustReadiness>;
} {
  return {
    async check() {
      const scannerNames = Object.keys(input.scanners);
      if (!input.enabled) {
        return {
          enabled: false,
          ready: false,
          artifactStore: 'disabled',
          policy: 'disabled',
          scanners: Object.fromEntries(scannerNames.map((name) => [name, 'disabled'])),
          sandbox: 'disabled',
          databaseClaims: 'disabled',
        };
      }

      const [artifactStore, policy, scannerEntries, sandbox, databaseClaims] = await Promise.all([
        availability(input.artifactStore),
        policyAvailability(input.policy),
        Promise.all(
          scannerNames.map(async (name) => [name, await scannerAvailability(input.scanners[name])] as const),
        ),
        availability(input.sandbox),
        availability(input.databaseClaims),
      ]);
      const scanners = Object.fromEntries(scannerEntries);
      const ready =
        artifactStore === 'ready' &&
        policy === 'ready' &&
        Object.values(scanners).every((status) => status === 'ready') &&
        sandbox === 'ready' &&
        databaseClaims === 'ready';

      return { enabled: true, ready, artifactStore, policy, scanners, sandbox, databaseClaims };
    },
  };
}
