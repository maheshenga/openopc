import type { DeveloperScannerAdapter, ScannerCommandRunner } from './types';
import {
  type CycloneDxBom,
  compareText,
  completedScannerResult,
  createScannerRuntime,
  inconclusiveScannerResult,
} from './types';

function packageUrl(name: string, version: string): string {
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function stringField(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
    ? value
    : null;
}

function hashFromIntegrity(
  integrity: string,
): { alg: 'SHA-256' | 'SHA-384' | 'SHA-512'; content: string } | null {
  const algorithms = {
    sha256: { alg: 'SHA-256' as const, bytes: 32 },
    sha384: { alg: 'SHA-384' as const, bytes: 48 },
    sha512: { alg: 'SHA-512' as const, bytes: 64 },
  };
  const candidates = integrity.trim().split(/\s+/);
  for (const name of ['sha512', 'sha384', 'sha256'] as const) {
    const candidate = candidates.find((value) => value.startsWith(`${name}-`));
    if (!candidate) continue;
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(candidate);
    if (!match) continue;
    const algorithm = algorithms[name];
    const decoded = Buffer.from(match[2], 'base64');
    if (decoded.byteLength !== algorithm.bytes) continue;
    return { alg: algorithm.alg, content: decoded.toString('hex') };
  }
  return null;
}

function normalizeBom(
  raw: Record<string, unknown>,
  input: Parameters<DeveloperScannerAdapter['scan']>[0],
): CycloneDxBom {
  if (raw.bomFormat !== 'CycloneDX' || !Array.isArray(raw.components)) {
    throw new TypeError('MALFORMED_SYFT_OUTPUT');
  }
  const rawComponents = raw.components.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new TypeError('MALFORMED_SYFT_COMPONENT');
    const component = entry as Record<string, unknown>;
    const name = stringField(component.name, 214);
    const version = stringField(component.version, 128);
    if (!name || !version) throw new TypeError('MALFORMED_SYFT_COMPONENT');
    const purl = packageUrl(name, version);
    return { type: 'library', name, version, purl, 'bom-ref': purl };
  });
  if (rawComponents.length > 10_000) throw new TypeError('TOO_MANY_SYFT_COMPONENTS');
  const byCoordinate = new Map(
    rawComponents.map((component) => [`${component.name}\0${component.version}`, component]),
  );
  const components = input.lockGraph
    ? input.lockGraph.nodes.map((node) => {
        const component = byCoordinate.get(`${node.name}\0${node.version}`);
        if (!component) throw new TypeError('SYFT_LOCK_GRAPH_MISMATCH');
        const hash = hashFromIntegrity(node.integrity);
        if (!hash) throw new TypeError('SYFT_LOCK_INTEGRITY_INVALID');
        return { ...component, hashes: [hash] };
      })
    : rawComponents;
  components.sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.version, right.version) ||
      compareText(left.purl, right.purl),
  );
  const dependencies = input.lockGraph
    ? input.lockGraph.nodes
        .map((node) => {
          const component = byCoordinate.get(`${node.name}\0${node.version}`);
          if (!component) throw new TypeError('SYFT_LOCK_GRAPH_MISMATCH');
          const dependsOn = Object.entries(node.dependencies)
            .map(([name, version]) => {
              const dependency = byCoordinate.get(`${name}\0${version}`);
              if (!dependency) throw new TypeError('SYFT_LOCK_GRAPH_MISMATCH');
              return dependency.purl;
            })
            .sort(compareText);
          return { ref: component.purl, dependsOn };
        })
        .sort((left, right) => compareText(left.ref, right.ref))
    : undefined;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    components,
    ...(dependencies ? { dependencies } : {}),
  };
}

export function createSyftScanner(runner: ScannerCommandRunner): DeveloperScannerAdapter {
  const runtime = createScannerRuntime('syft', runner);
  return {
    name: 'syft',
    verifyIdentity: runtime.verifyIdentity,
    async scan(input, signal) {
      const processResult = await runtime.run(input, signal, ['.', '-o', 'cyclonedx-json']);
      if (processResult.kind === 'inconclusive') {
        return inconclusiveScannerResult('syft', processResult.reason);
      }
      if (processResult.exitCode !== 0) {
        return inconclusiveScannerResult('syft', 'scanner_unavailable');
      }
      try {
        const parsed = JSON.parse(processResult.stdout) as Record<string, unknown>;
        const sbom = normalizeBom(parsed, input);
        return completedScannerResult({ scanner: 'syft', findings: [], sbom });
      } catch {
        return inconclusiveScannerResult('syft', 'malformed_output');
      }
    },
  };
}
