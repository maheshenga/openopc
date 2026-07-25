import type { DeveloperScannerAdapter, ScannerCommandRunner } from './types';
import {
  type ScannerSeverity,
  completedScannerResult,
  createScannerFinding,
  createScannerRuntime,
  inconclusiveScannerResult,
} from './types';

function severityOf(vulnerability: Record<string, unknown>): ScannerSeverity {
  const database = vulnerability.database_specific;
  const value =
    database && typeof database === 'object'
      ? String((database as Record<string, unknown>).severity ?? '')
      : '';
  switch (value.toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'high';
  }
}

export function createOsvScanner(runner: ScannerCommandRunner): DeveloperScannerAdapter {
  const runtime = createScannerRuntime('osv-scanner', runner);
  return {
    name: 'osv-scanner',
    verifyIdentity: runtime.verifyIdentity,
    async scan(input, signal) {
      const processResult = await runtime.run(input, signal, [
        'scan',
        '--format=json',
        '--recursive',
        '.',
      ]);
      if (processResult.kind === 'inconclusive') {
        return inconclusiveScannerResult('osv-scanner', processResult.reason);
      }
      if (processResult.exitCode !== 0 && processResult.exitCode !== 1) {
        return inconclusiveScannerResult('osv-scanner', 'scanner_unavailable');
      }
      try {
        const parsed = JSON.parse(processResult.stdout) as Record<string, unknown>;
        if (!parsed || !Array.isArray(parsed.results)) throw new TypeError('MALFORMED_OSV_OUTPUT');
        const findings = [];
        for (const result of parsed.results) {
          if (!result || typeof result !== 'object') throw new TypeError('MALFORMED_OSV_RESULT');
          const packages = (result as Record<string, unknown>).packages;
          if (!Array.isArray(packages)) throw new TypeError('MALFORMED_OSV_PACKAGES');
          for (const packageResult of packages) {
            if (!packageResult || typeof packageResult !== 'object') {
              throw new TypeError('MALFORMED_OSV_PACKAGE');
            }
            const vulnerabilities = (packageResult as Record<string, unknown>).vulnerabilities;
            if (!Array.isArray(vulnerabilities))
              throw new TypeError('MALFORMED_OSV_VULNERABILITIES');
            for (const vulnerability of vulnerabilities) {
              if (!vulnerability || typeof vulnerability !== 'object') {
                throw new TypeError('MALFORMED_OSV_VULNERABILITY');
              }
              findings.push(
                createScannerFinding({
                  scanner: 'osv-scanner',
                  ruleId: (vulnerability as Record<string, unknown>).id,
                  severity: severityOf(vulnerability as Record<string, unknown>),
                  summary: 'A dependency has a known vulnerability',
                }),
              );
              if (findings.length > 1_000) throw new TypeError('TOO_MANY_OSV_FINDINGS');
            }
          }
        }
        if (processResult.exitCode === 1 && findings.length === 0) {
          return inconclusiveScannerResult('osv-scanner', 'malformed_output');
        }
        return completedScannerResult({ scanner: 'osv-scanner', findings });
      } catch {
        return inconclusiveScannerResult('osv-scanner', 'malformed_output');
      }
    },
  };
}
