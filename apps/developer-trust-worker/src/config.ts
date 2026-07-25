export interface DeveloperTrustWorkerConfig {
  enabled: boolean;
  workerId: string;
  leaseMs: number;
  policyJson: string | null;
  evidencePrivateKey: string | null;
  evidenceKeyId: string | null;
  evidenceIssuer: string | null;
}

export function loadDeveloperTrustWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DeveloperTrustWorkerConfig {
  const enabledValue = environment.DEVELOPER_TRUST_ENABLED;
  if (enabledValue !== undefined && enabledValue !== 'true' && enabledValue !== 'false') {
    throw new Error('DEVELOPER_TRUST_CONFIG_INVALID');
  }
  if (enabledValue !== 'true') {
    return {
      enabled: false,
      workerId: 'developer-trust-disabled',
      leaseMs: 30_000,
      policyJson: null,
      evidencePrivateKey: null,
      evidenceKeyId: null,
      evidenceIssuer: null,
    };
  }

  const workerId = environment.DEVELOPER_TRUST_WORKER_ID;
  const leaseText = environment.DEVELOPER_TRUST_LEASE_MS;
  const policyJson = environment.DEVELOPER_TRUST_POLICY_JSON;
  const evidencePrivateKey = environment.DEVELOPER_TRUST_EVIDENCE_PRIVATE_KEY;
  const evidenceKeyId = environment.DEVELOPER_TRUST_EVIDENCE_KEY_ID;
  const evidenceIssuer = environment.DEVELOPER_TRUST_EVIDENCE_ISSUER;
  try {
    const leaseMs = Number(leaseText);
    if (
      !workerId ||
      !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(workerId) ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 5_000 ||
      leaseMs > 300_000 ||
      !policyJson ||
      Buffer.byteLength(policyJson, 'utf8') > 1024 * 1024 ||
      !evidencePrivateKey ||
      Buffer.byteLength(evidencePrivateKey, 'utf8') > 64 * 1024 ||
      !evidenceKeyId ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(evidenceKeyId) ||
      !evidenceIssuer ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(evidenceIssuer)
    ) {
      throw new Error('INVALID');
    }
    const parsedPolicy = JSON.parse(policyJson) as unknown;
    if (
      !parsedPolicy ||
      typeof parsedPolicy !== 'object' ||
      (parsedPolicy as { schema?: unknown }).schema !== 1
    ) {
      throw new Error('INVALID');
    }
    return {
      enabled: true,
      workerId,
      leaseMs,
      policyJson,
      evidencePrivateKey,
      evidenceKeyId,
      evidenceIssuer,
    };
  } catch {
    throw new Error('DEVELOPER_TRUST_CONFIG_INVALID');
  }
}
