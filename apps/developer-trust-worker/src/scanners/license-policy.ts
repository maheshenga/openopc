import type { DeveloperScannerAdapter } from './types';
import {
  completedScannerResult,
  createScannerFinding,
  evidenceDigest,
  inconclusiveScannerResult,
} from './types';

export function createLicensePolicyScanner(input: {
  allowedLicenses: readonly string[];
}): DeveloperScannerAdapter {
  const allowedLicenses = new Set(
    input.allowedLicenses.filter(
      (license) =>
        typeof license === 'string' &&
        license.length > 0 &&
        license.length <= 128 &&
        !/[\0\r\n]/.test(license),
    ),
  );
  return {
    name: 'license-policy',
    async verifyIdentity(policy) {
      if (!policy.scanners.some((scanner) => scanner.name === 'license-policy')) {
        throw new Error('SCANNER_POLICY_MISSING');
      }
    },
    async scan(scanInput, signal) {
      if (signal.aborted) return inconclusiveScannerResult('license-policy', 'cancelled');
      if (scanInput.dependencyLicenses.length > 10_000) {
        return inconclusiveScannerResult('license-policy', 'malformed_output');
      }
      const findings = scanInput.dependencyLicenses
        .filter((dependency) => !allowedLicenses.has(dependency.license))
        .map((dependency) =>
          createScannerFinding({
            scanner: 'license-policy',
            ruleId: `license-not-allowed:${evidenceDigest(dependency).slice(-16)}`,
            severity: 'high',
            summary: 'A dependency uses a disallowed license',
          }),
        );
      return completedScannerResult({ scanner: 'license-policy', findings });
    },
  };
}
