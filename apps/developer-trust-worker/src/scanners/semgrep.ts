import type { DeveloperScannerAdapter, ScannerCommandRunner } from './types';
import {
  type ScannerSeverity,
  completedScannerResult,
  createScannerFinding,
  createScannerRuntime,
  inconclusiveScannerResult,
} from './types';

function severityOf(value: unknown): ScannerSeverity {
  switch (String(value ?? '').toUpperCase()) {
    case 'ERROR':
      return 'high';
    case 'WARNING':
      return 'medium';
    case 'INFO':
      return 'low';
    default:
      return 'high';
  }
}

export function createSemgrepScanner(runner: ScannerCommandRunner): DeveloperScannerAdapter {
  const runtime = createScannerRuntime('semgrep', runner);
  return {
    name: 'semgrep',
    verifyIdentity: runtime.verifyIdentity,
    async scan(input, signal) {
      const processResult = await runtime.run(input, signal, [
        'scan',
        '--json',
        '--metrics=off',
        '--disable-version-check',
        '.',
      ]);
      if (processResult.kind === 'inconclusive') {
        return inconclusiveScannerResult('semgrep', processResult.reason);
      }
      if (processResult.exitCode !== 0 && processResult.exitCode !== 1) {
        return inconclusiveScannerResult('semgrep', 'scanner_unavailable');
      }
      try {
        const parsed = JSON.parse(processResult.stdout) as Record<string, unknown>;
        if (!parsed || !Array.isArray(parsed.results) || !Array.isArray(parsed.errors)) {
          throw new TypeError('MALFORMED_SEMGREP_OUTPUT');
        }
        if (parsed.errors.length > 0)
          return inconclusiveScannerResult('semgrep', 'scanner_unavailable');
        if (parsed.results.length > 1_000) throw new TypeError('TOO_MANY_SEMGREP_FINDINGS');
        const findings = parsed.results.map((entry) => {
          if (!entry || typeof entry !== 'object') throw new TypeError('MALFORMED_SEMGREP_FINDING');
          const result = entry as Record<string, unknown>;
          const start =
            result.start && typeof result.start === 'object'
              ? (result.start as Record<string, unknown>)
              : null;
          const extra =
            result.extra && typeof result.extra === 'object'
              ? (result.extra as Record<string, unknown>)
              : null;
          return createScannerFinding({
            scanner: 'semgrep',
            ruleId: result.check_id,
            severity: severityOf(extra?.severity),
            path: result.path,
            location:
              typeof start?.line === 'number' && typeof start?.col === 'number'
                ? { line: start.line, column: start.col }
                : null,
            summary: 'A static analysis policy rule matched',
          });
        });
        if (processResult.exitCode === 1 && findings.length === 0) {
          return inconclusiveScannerResult('semgrep', 'malformed_output');
        }
        return completedScannerResult({ scanner: 'semgrep', findings });
      } catch {
        return inconclusiveScannerResult('semgrep', 'malformed_output');
      }
    },
  };
}
