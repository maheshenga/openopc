import { Gauge } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { GatewayOpsSnapshot } from '@/hooks/admin/use-ops-overview';

export function GatewayOpsPanel({ gateway }: { gateway: GatewayOpsSnapshot }) {
  const metrics = [
    {
      label: 'Requests',
      value: formatCount(gateway.requests_24h),
      hint: `${formatCount(gateway.errors_24h)} errors`,
    },
    {
      label: 'Error rate',
      value: formatPercent(gateway.error_rate_24h),
      hint: gateway.errors_24h > 0 ? 'Needs attention' : 'Healthy',
    },
    {
      label: 'Retries',
      value: formatCount(gateway.retries_24h),
      hint: 'Additional upstream attempts',
    },
    {
      label: 'Tokens',
      value: formatCount(gateway.tokens_24h),
      hint: `${formatCount(gateway.input_tokens_24h)} in / ${formatCount(gateway.output_tokens_24h)} out / ${formatCount(gateway.cached_tokens_24h)} cached`,
    },
    {
      label: 'Cost',
      value: formatUsd(gateway.cost_usd_24h),
      hint: 'Final gateway cost',
    },
    { label: 'p50', value: formatLatency(gateway.latency_ms.p50), hint: 'Median latency' },
    { label: 'p95', value: formatLatency(gateway.latency_ms.p95), hint: 'Tail latency' },
    { label: 'p99', value: formatLatency(gateway.latency_ms.p99), hint: 'Extreme tail' },
  ];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Gauge className="text-muted-foreground size-4 shrink-0" />
          <h2 className="text-balance text-sm font-semibold">Gateway health</h2>
        </div>
        <Badge variant="secondary" size="sm">
          Last 24h
        </Badge>
      </div>

      <div className="border-border/60 bg-popover overflow-hidden rounded-md border">
        <dl className="bg-border/60 grid grid-cols-2 gap-px lg:grid-cols-4">
          {metrics.map((metric) => (
            <div key={metric.label} className="bg-popover min-w-0 px-4 py-3">
              <dt className="text-muted-foreground text-xs font-medium">{metric.label}</dt>
              <dd className="mt-1 truncate text-lg font-semibold tabular-nums">{metric.value}</dd>
              <dd className="text-muted-foreground mt-0.5 truncate text-xs">{metric.hint}</dd>
            </div>
          ))}
        </dl>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">Errors</TableHead>
            <TableHead className="text-right">Retries</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {gateway.by_provider.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground text-center">
                No gateway requests in the last 24 hours.
              </TableCell>
            </TableRow>
          ) : (
            gateway.by_provider.map((row) => (
              <TableRow key={row.provider}>
                <TableCell className="font-medium">{row.provider}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(row.requests)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(row.errors)} ({formatPercent(row.error_rate)})
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(row.retries)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(row.tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatUsd(row.cost_usd)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

function formatCount(value: number) {
  return value.toLocaleString('en-US');
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number) {
  return `$${value.toFixed(4)}`;
}

function formatLatency(value: number) {
  if (value < 1_000) return `${value.toLocaleString('en-US')}ms`;
  return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}s`;
}
