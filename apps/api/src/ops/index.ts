import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/require-admin';
import { config } from '../config';
import { getTunnelServiceStatus } from '../tunnel';
import { isOtelTraceExporterConfigured } from '../lib/otel';
import { makeOpenApiApp, json, errors, auth } from '../openapi';

export const opsApp = makeOpenApiApp<AppEnv>();

opsApp.use('/*', supabaseAuth);
opsApp.use('/*', requireAdmin);

type CountRow = { count: number | string | null };
type GroupCountRow = { key: string | null; count: number | string | null };

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

async function oneCount(query: ReturnType<typeof sql>): Promise<number> {
  const rows = resultRows<CountRow>(await db.execute(query));
  return Number(rows[0]?.count ?? 0);
}

async function groupCounts(query: ReturnType<typeof sql>): Promise<Record<string, number>> {
  const rows = resultRows<GroupCountRow>(await db.execute(query));
  return Object.fromEntries(rows.map((row) => [row.key ?? 'unknown', Number(row.count ?? 0)]));
}

async function recentAuditEvents() {
  const rows = resultRows<{
    event_id: string;
    account_id: string | null;
    actor_user_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    occurred_at: Date | string;
  }>(await db.execute(sql`
    SELECT event_id, account_id, actor_user_id, action, resource_type, resource_id, occurred_at
    FROM kortix.audit_events
    ORDER BY occurred_at DESC
    LIMIT 10
  `));

  return rows.map((row) => ({
    event_id: row.event_id,
    account_id: row.account_id,
    actor_user_id: row.actor_user_id,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    occurred_at: new Date(row.occurred_at).toISOString(),
  }));
}

async function usageLast24h() {
  const rows = resultRows<{
    provider: string;
    calls: number | string;
    input_tokens: number | string | null;
    output_tokens: number | string | null;
    cached_tokens: number | string | null;
    cost_usd: string | number | null;
  }>(await db.execute(sql`
    SELECT
      provider,
      count(*)::int AS calls,
      COALESCE(sum(input_tokens), 0)::int AS input_tokens,
      COALESCE(sum(output_tokens), 0)::int AS output_tokens,
      COALESCE(sum(cached_tokens), 0)::int AS cached_tokens,
      COALESCE(sum(cost_usd), 0)::text AS cost_usd
    FROM kortix.usage_events
    WHERE created_at >= now() - interval '24 hours'
    GROUP BY provider
    ORDER BY calls DESC
  `));

  return rows.map((row) => ({
    provider: row.provider,
    calls: Number(row.calls ?? 0),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    cached_tokens: Number(row.cached_tokens ?? 0),
    cost_usd: Number(row.cost_usd ?? 0),
  }));
}

async function gatewayLast24h() {
  type GatewayAggregateRow = {
    provider: string | null;
    requests: number | string | null;
    errors: number | string | null;
    retries: number | string | null;
    input_tokens: number | string | null;
    output_tokens: number | string | null;
    cached_tokens: number | string | null;
    cost_usd: number | string | null;
    p50_ms: number | string | null;
    p95_ms: number | string | null;
    p99_ms: number | string | null;
  };

  const rows = resultRows<GatewayAggregateRow>(
    await db.execute(sql`
      SELECT
        provider,
        count(*)::int AS requests,
        count(*) FILTER (WHERE NOT ok)::int AS errors,
        COALESCE(sum(GREATEST(attempts - 1, 0)), 0)::int AS retries,
        COALESCE(sum(input_tokens), 0)::text AS input_tokens,
        COALESCE(sum(output_tokens), 0)::text AS output_tokens,
        COALESCE(sum(cached_tokens), 0)::text AS cached_tokens,
        COALESCE(sum(final_cost), 0)::text AS cost_usd,
        COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p50_ms,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_ms,
        COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p99_ms
      FROM kortix.gateway_request_logs
      WHERE created_at >= now() - interval '24 hours'
      GROUP BY GROUPING SETS ((), (provider))
      ORDER BY GROUPING(provider) DESC, requests DESC
    `),
  );
  const summary = rows.find((row) => row.provider === null);
  const requests = Number(summary?.requests ?? 0);
  const errors = Number(summary?.errors ?? 0);
  const inputTokens = Number(summary?.input_tokens ?? 0);
  const outputTokens = Number(summary?.output_tokens ?? 0);

  const byProvider = rows
    .filter((row): row is GatewayAggregateRow & { provider: string } => row.provider !== null)
    .map((row) => {
      const providerRequests = Number(row.requests ?? 0);
      const providerErrors = Number(row.errors ?? 0);
      const providerInputTokens = Number(row.input_tokens ?? 0);
      const providerOutputTokens = Number(row.output_tokens ?? 0);
      return {
        provider: row.provider,
        requests: providerRequests,
        errors: providerErrors,
        error_rate: providerRequests > 0 ? providerErrors / providerRequests : 0,
        retries: Number(row.retries ?? 0),
        input_tokens: providerInputTokens,
        output_tokens: providerOutputTokens,
        cached_tokens: Number(row.cached_tokens ?? 0),
        tokens: providerInputTokens + providerOutputTokens,
        cost_usd: Number(row.cost_usd ?? 0),
      };
    });

  return {
    requests_24h: requests,
    errors_24h: errors,
    error_rate_24h: requests > 0 ? errors / requests : 0,
    retries_24h: Number(summary?.retries ?? 0),
    input_tokens_24h: inputTokens,
    output_tokens_24h: outputTokens,
    cached_tokens_24h: Number(summary?.cached_tokens ?? 0),
    tokens_24h: inputTokens + outputTokens,
    cost_usd_24h: Number(summary?.cost_usd ?? 0),
    latency_ms: {
      p50: Number(summary?.p50_ms ?? 0),
      p95: Number(summary?.p95_ms ?? 0),
      p99: Number(summary?.p99_ms ?? 0),
    },
    by_provider: byProvider,
  };
}

function observabilityStatus() {
  return {
    managed_logs_configured: Boolean(process.env.BETTERSTACK_API_LOG_TOKEN),
    managed_log_host: process.env.BETTERSTACK_API_LOG_TOKEN
      ? process.env.BETTERSTACK_API_LOG_HOST || 'default'
      : null,
    error_tracking_configured: Boolean(process.env.BETTERSTACK_API_SENTRY_DSN),
    structured_request_logs_enabled: true,
    trace_headers_enabled: true,
    otlp_exporter_configured: isOtelTraceExporterConfigured(),
    otlp_request_spans_enabled: isOtelTraceExporterConfigured(),
  };
}

opsApp.openapi(
  createRoute({
    method: 'get',
    path: '/overview',
    tags: ['ops'],
    summary: 'Platform operations overview dashboard',
    ...auth,
    responses: {
      200: json(z.record(z.string(), z.any()), 'Operations overview snapshot'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
  const [
    accountCount,
    projectCount,
    activeLegacySandboxes,
    sessionStatus,
    sandboxStatus,
    sandboxProviders,
    triggerEventStatus,
    audit24h,
    migrationStatus,
    usage,
    recentAudit,
    gateway,
  ] = await Promise.all([
    oneCount(sql`SELECT count(*)::int AS count FROM kortix.accounts`),
    oneCount(sql`SELECT count(*)::int AS count FROM kortix.projects`),
    oneCount(sql`
      SELECT count(*)::int AS count
      FROM kortix.sandboxes
      WHERE status IN ('provisioning', 'active', 'stopped', 'error')
    `),
    groupCounts(sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.project_sessions
      GROUP BY status
    `),
    groupCounts(sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.session_sandboxes
      GROUP BY status
    `),
    groupCounts(sql`
      SELECT provider AS key, count(*)::int AS count
      FROM kortix.session_sandboxes
      GROUP BY provider
    `),
    // Triggers are file-defined (kortix.yaml) now; the project_trigger_events
    // table is gone and the git path doesn't persist events, so this is always
    // empty. Field kept for dashboard compatibility.
    Promise.resolve<Record<string, number>>({}),
    oneCount(sql`
      SELECT count(*)::int AS count
      FROM kortix.audit_events
      WHERE occurred_at >= now() - interval '24 hours'
    `),
    groupCounts(sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.legacy_sandbox_migrations
      GROUP BY status
    `),
    usageLast24h(),
    recentAuditEvents(),
    gatewayLast24h(),
  ]);

  const queuedTriggerEvents = triggerEventStatus.queued ?? 0;
  const erroredSessions = sessionStatus.failed ?? 0;
  const erroredSandboxes = sandboxStatus.error ?? 0;

  return c.json({
    generated_at: new Date().toISOString(),
    api: {
      status: 'ok',
      env: config.INTERNAL_KORTIX_ENV,
      billing_enabled: config.KORTIX_BILLING_INTERNAL_ENABLED,
      tunnel: getTunnelServiceStatus(),
    },
    totals: {
      accounts: accountCount,
      projects: projectCount,
      active_legacy_sandboxes: activeLegacySandboxes,
    },
    sessions: {
      by_status: sessionStatus,
      errored: erroredSessions,
    },
    sandboxes: {
      by_status: sandboxStatus,
      by_provider: sandboxProviders,
      errored: erroredSandboxes,
    },
    queues: {
      trigger_events_by_status: triggerEventStatus,
      // Channel events are file-defined now (no queue table); kept for dashboard
      // shape compatibility so the UI never reads an undefined map.
      channel_events_by_status: {},
      queued_total: queuedTriggerEvents,
    },
    audit: {
      events_24h: audit24h,
      recent: recentAudit,
    },
    usage: {
      last_24h_by_provider: usage,
      calls_24h: usage.reduce((sum, row) => sum + row.calls, 0),
      cost_usd_24h: usage.reduce((sum, row) => sum + row.cost_usd, 0),
    },
    gateway,
    observability: observabilityStatus(),
    migrations: {
      by_status: migrationStatus,
      active_legacy_sandboxes: activeLegacySandboxes,
    },
  });
  },
);
