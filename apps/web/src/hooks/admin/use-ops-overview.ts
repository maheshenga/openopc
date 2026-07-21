import { backendApi } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';

export interface OpsOverview {
  generated_at: string;
  api: {
    status: string;
    env: string;
    tunnel: Record<string, unknown>;
  };
  totals: {
    accounts: number;
    projects: number;
    active_legacy_sandboxes: number;
  };
  sessions: {
    by_status: Record<string, number>;
    errored: number;
  };
  sandboxes: {
    by_status: Record<string, number>;
    by_provider: Record<string, number>;
    errored: number;
  };
  queues: {
    trigger_events_by_status: Record<string, number>;
    channel_events_by_status: Record<string, number>;
    queued_total: number;
  };
  audit: {
    events_24h: number;
    recent: Array<{
      event_id: string;
      account_id: string | null;
      actor_user_id: string | null;
      action: string;
      resource_type: string;
      resource_id: string | null;
      occurred_at: string;
    }>;
  };
  usage: {
    last_24h_by_provider: Array<{
      provider: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cost_usd: number;
    }>;
    calls_24h: number;
    cost_usd_24h: number;
  };
  gateway?: GatewayOpsSnapshot;
  observability: {
    managed_logs_configured: boolean;
    managed_log_host: string | null;
    error_tracking_configured: boolean;
    trace_headers_enabled: boolean;
    otlp_exporter_configured: boolean;
  };
  migrations: {
    by_status: Record<string, number>;
    active_legacy_sandboxes: number;
  };
}

export interface GatewayOpsSnapshot {
  requests_24h: number;
  errors_24h: number;
  error_rate_24h: number;
  retries_24h: number;
  input_tokens_24h: number;
  output_tokens_24h: number;
  cached_tokens_24h: number;
  tokens_24h: number;
  cost_usd_24h: number;
  latency_ms: {
    p50: number;
    p95: number;
    p99: number;
  };
  by_provider: Array<{
    provider: string;
    requests: number;
    errors: number;
    error_rate: number;
    retries: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    tokens: number;
    cost_usd: number;
  }>;
}

export function useOpsOverview() {
  return useQuery<OpsOverview>({
    queryKey: ['admin', 'ops', 'overview'],
    queryFn: async () => {
      const response = await backendApi.get<OpsOverview>('/ops/overview');
      if (response.error) throw new Error(response.error.message);
      if (!response.data) throw new Error('Operations overview returned no data');
      return response.data;
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}
