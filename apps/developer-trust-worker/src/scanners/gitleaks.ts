import type { DeveloperScannerAdapter, ScannerCommandRunner } from './types';
import {
  completedScannerResult,
  createScannerFinding,
  createScannerRuntime,
  inconclusiveScannerResult,
} from './types';

export function createGitleaksScanner(runner: ScannerCommandRunner): DeveloperScannerAdapter {
  const runtime = createScannerRuntime('gitleaks', runner);
  return {
    name: 'gitleaks',
    verifyIdentity: runtime.verifyIdentity,
    async scan(input, signal) {
      const processResult = await runtime.run(input, signal, [
        'detect',
        '--source',
        '.',
        '--report-format',
        'json',
        '--report-path',
        '-',
        '--no-banner',
      ]);
      if (processResult.kind === 'inconclusive') {
        return inconclusiveScannerResult('gitleaks', processResult.reason);
      }
      if (processResult.exitCode !== 0 && processResult.exitCode !== 1) {
        return inconclusiveScannerResult('gitleaks', 'scanner_unavailable');
      }
      let parsed: unknown;
      try {
        parsed = processResult.stdout.trim() === '' ? [] : JSON.parse(processResult.stdout);
      } catch {
        return inconclusiveScannerResult('gitleaks', 'malformed_output');
      }
      if (!Array.isArray(parsed) || parsed.length > 1_000) {
        return inconclusiveScannerResult('gitleaks', 'malformed_output');
      }
      try {
        const findings = parsed.map((entry) => {
          if (!entry || typeof entry !== 'object') {
            throw new TypeError('MALFORMED_GITLEAKS_FINDING');
          }
          const finding = entry as Record<string, unknown>;
          return createScannerFinding({
            scanner: 'gitleaks',
            ruleId: finding.RuleID,
            severity: 'critical',
            path: finding.File,
            location: typeof finding.StartLine === 'number' ? { line: finding.StartLine } : null,
            summary: 'A credential pattern was detected',
          });
        });
        if (processResult.exitCode === 1 && findings.length === 0) {
          return inconclusiveScannerResult('gitleaks', 'malformed_output');
        }
        return completedScannerResult({ scanner: 'gitleaks', findings });
      } catch {
        return inconclusiveScannerResult('gitleaks', 'malformed_output');
      }
    },
  };
}
