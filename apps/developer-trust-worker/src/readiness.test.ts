import { expect, test } from 'bun:test';

import { createDeveloperTrustReadiness } from './readiness';

test('enabled readiness exposes every trust dependency and fails closed on a missing signer', async () => {
  const ready = async () => undefined;
  const readiness = createDeveloperTrustReadiness({
    enabled: true,
    components: {
      objectStorage: { probe: ready },
      postgresClaims: { probe: ready },
      policy: { probe: ready, unavailableReason: 'invalid' },
      gitleaks: { probe: ready },
      syft: { probe: ready },
      osv: { probe: ready },
      semgrep: { probe: ready },
      licensePolicy: { probe: ready },
      attestationSigner: {
        probe: async () => {
          throw new Error('missing fixture');
        },
        unavailableReason: 'not_configured',
      },
      sandboxControl: { probe: ready },
    },
  });

  await expect(readiness.check()).resolves.toMatchObject({
    enabled: true,
    ready: false,
    components: {
      attestationSigner: { ready: false, reason: 'not_configured' },
      objectStorage: { ready: true, reason: 'ready' },
      postgresClaims: { ready: true, reason: 'ready' },
    },
  });
});
