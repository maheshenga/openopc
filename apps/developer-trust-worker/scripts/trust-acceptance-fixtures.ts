import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { evidenceDigest } from '../src/scanners/types';

const mode = process.argv[2];
const scannerEnvironment = {
  HOME: '/tmp/openopc-developer-trust',
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  SEMGREP_ENABLE_VERSION_CHECK: '0',
  SEMGREP_SEND_METRICS: 'off',
};

if (mode === '--init-secrets') {
  const directory = process.argv[3];
  if (!directory) throw new Error('secret directory is required');
  mkdirSync(directory, { recursive: true });
  const privateKeyPath = join(directory, 'attestation.pk8');
  const publicKeyPath = join(directory, 'attestation.spki');
  if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(privateKeyPath, pair.privateKey.export({ format: 'der', type: 'pkcs8' }));
    writeFileSync(publicKeyPath, pair.publicKey.export({ format: 'der', type: 'spki' }));
  }
  writeText(
    join(directory, 'database-url'),
    'postgres://openopc:openopc-test@postgres:5432/openopc_trust_test',
  );
  writeText(join(directory, 's3-access-key-id'), 'openopc-test-access');
  writeText(join(directory, 's3-secret-access-key'), 'openopc-test-secret-change-me');
  const tokenPath = join(directory, 'oci-control-token');
  if (!existsSync(tokenPath)) writeText(tokenPath, randomBytes(32).toString('base64url'));
  for (const path of [
    privateKeyPath,
    publicKeyPath,
    tokenPath,
    join(directory, 'database-url'),
    join(directory, 's3-access-key-id'),
    join(directory, 's3-secret-access-key'),
  ]) {
    chmodSync(path, 0o400);
    chownSync(path, 65_532, 65_532);
  }
  process.exit(0);
}

if (mode !== '--policy') throw new Error('expected --policy or --init-secrets');

const allowedLicenses = JSON.parse(
  process.env.DEVELOPER_TRUST_ALLOWED_LICENSES_JSON ?? '["Apache-2.0","MIT"]',
) as string[];
const scanners = [
  scanner('gitleaks', '/opt/openopc/scanners/gitleaks'),
  scanner('syft', '/opt/openopc/scanners/syft'),
  scanner('osv-scanner', '/opt/openopc/scanners/osv-scanner'),
  scanner('semgrep', '/usr/bin/semgrep', fileDigest('/opt/openopc/policies/semgrep.yml')),
  {
    name: 'license-policy',
    executable: '/opt/openopc/scanners/license-policy',
    imageDigest: evidenceDigest({ implementation: 'openopc-license-policy-v1' }),
    version: 'openopc-license-policy-v1',
    ruleDigest: evidenceDigest([...allowedLicenses].sort()),
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  },
];
const profiles = [
  'declarative',
  'agent-project',
  'sandboxed-web',
  'server-conformance',
  'desktop-package',
] as const;
const sandboxProfiles = Object.fromEntries(
  profiles.map((profile) => [
    profile,
    {
      profile,
      profileDigest: evidenceDigest({ profile, revision: 1 }),
      imageDigest: evidenceDigest({ image: 'openopc-trust-acceptance-harness', revision: 1 }),
      network: 'none',
      timeoutMs: 60_000,
      memoryBytes: 512 * 1024 * 1024,
      cpuMillis: 1_000,
      pidsLimit: 128,
    },
  ]),
);

process.stdout.write(
  JSON.stringify({
    schema: 1,
    policyId: 'openopc-developer-trust-acceptance-2026-07',
    scanners,
    advisorySnapshot: 'osv-acceptance-v2.0.2',
    sandboxProfiles,
    blockingSeverities: ['critical', 'high'],
  }),
);

function scanner(name: string, executable: string, ruleDigest?: `sha256:${string}`) {
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    env: scannerEnvironment,
    timeout: 30_000,
    maxBuffer: 4_096,
  })
    .trim()
    .split(/\r?\n/, 1)[0];
  return {
    name,
    executable,
    imageDigest: fileDigest(executable),
    version,
    ruleDigest: ruleDigest ?? evidenceDigest({ name, version }),
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  };
}

function fileDigest(path: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function writeText(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o400 });
}
