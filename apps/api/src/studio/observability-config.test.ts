import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const repositoryRoot = resolve(import.meta.dir, '../../../..');

const requiredStudioSeries = [
  'studio_provider_requests_total',
  'studio_unknown_outcomes_total',
  'studio_storage_operations_total',
  'studio_estimate_violations_total',
  'studio_platform_loss_credits_total',
  'studio_recovery_decisions_total',
  'studio_storage_readiness',
  'studio_queue_oldest_age_seconds',
  'studio_reservation_oldest_age_seconds',
  'studio_orphan_staging_objects',
  'studio_provider_request_duration_seconds',
  'studio_storage_operation_duration_seconds',
] as const;

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

describe('Studio production observability configuration', () => {
  test('keeps every required series scraped or ruled and gates production enablement on incident resolution', () => {
    const alerts = parse(readRepositoryFile('infra/k8s/observability/kortix-alerts.yaml')) as {
      spec: { groups: Array<{ name: string; rules: Array<{ expr?: string }> }> };
    };
    const chartValues = parse(readRepositoryFile('infra/k8s/charts/kortix-api/values.yaml')) as {
      serviceMonitor: { path: string };
      studioWorker: { serviceMonitor: { enabled: boolean } };
    };
    const productionValues = parse(readRepositoryFile('infra/k8s/envs/prod/values.yaml')) as {
      studioWorker?: { enabled?: boolean; env?: { STUDIO_ENABLED?: string } };
    };
    const studioRuleGroup = alerts.spec.groups.find(
      (group) => group.name === 'studio-runtime.rules',
    );
    expect(studioRuleGroup).toBeDefined();
    const ruleExpressions = (studioRuleGroup?.rules ?? [])
      .map((rule) => rule.expr ?? '')
      .join('\n');

    const apiMetrics = readRepositoryFile('apps/api/src/studio/metrics.ts');
    const workerMetrics = readRepositoryFile('apps/studio-worker/src/metrics.ts');
    const apiServiceMonitor = readRepositoryFile(
      'infra/k8s/charts/kortix-api/templates/servicemonitor.yaml',
    );
    const workerServiceMonitor = readRepositoryFile(
      'infra/k8s/charts/kortix-api/templates/studio-worker-servicemonitor.yaml',
    );
    const apiScraped =
      chartValues.serviceMonitor.path === '/metrics' &&
      apiServiceMonitor.includes('path: {{ .Values.serviceMonitor.path }}');
    const workerScraped = workerServiceMonitor.includes('path: /metrics');

    for (const series of requiredStudioSeries) {
      const producedByApi = apiMetrics.includes(series);
      const producedByWorker = workerMetrics.includes(series);
      const consumedByRule = ruleExpressions.includes(series);
      expect(producedByApi || producedByWorker).toBe(true);
      expect(
        consumedByRule || (producedByApi && apiScraped) || (producedByWorker && workerScraped),
      ).toBe(true);
    }

    const accountRoutes = readRepositoryFile('apps/api/src/studio/account-routes.ts');
    const defaultAccountRoutes = readRepositoryFile(
      'apps/api/src/studio/default-account-routes.ts',
    );
    const billingIncidents = readRepositoryFile('apps/api/src/studio/billing-incidents.ts');
    const incidentOperationReady =
      accountRoutes.includes('/:accountId/studio/billing-incidents/:incidentId/resolve') &&
      accountRoutes.includes('ACCOUNT_ACTIONS.BILLING_WRITE') &&
      defaultAccountRoutes.includes('createDrizzleStudioBillingIncidentRepository') &&
      billingIncidents.includes("'record_platform_liability'");
    expect(incidentOperationReady).toBe(true);

    const productionStudioEnabled =
      productionValues.studioWorker?.enabled === true &&
      productionValues.studioWorker.env?.STUDIO_ENABLED === 'true';
    expect(productionStudioEnabled && !incidentOperationReady).toBe(false);
    expect(chartValues.studioWorker.serviceMonitor.enabled).toBe(false);
  });
});
