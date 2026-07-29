import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GatewayOpsPanel } from './gateway-ops-panel';

describe('GatewayOpsPanel', () => {
  test('renders the 24 hour gateway health and provider distribution', () => {
    const html = renderToStaticMarkup(
      <GatewayOpsPanel
        gateway={{
          requests_24h: 8,
          errors_24h: 2,
          error_rate_24h: 0.25,
          retries_24h: 3,
          input_tokens_24h: 240,
          output_tokens_24h: 80,
          cached_tokens_24h: 20,
          tokens_24h: 320,
          cost_usd_24h: 0.42,
          latency_ms: { p50: 120, p95: 900, p99: 1400 },
          by_provider: [
            {
              provider: 'openai',
              requests: 6,
              errors: 1,
              error_rate: 1 / 6,
              retries: 2,
              input_tokens: 180,
              output_tokens: 60,
              cached_tokens: 15,
              tokens: 240,
              cost_usd: 0.3,
            },
          ],
        }}
      />,
    );

    expect(html).toContain('Gateway health');
    expect(html).toContain('Requests');
    expect(html).toContain('25.0%');
    expect(html).toContain('Retries');
    expect(html).toContain('$0.4200');
    expect(html).toContain('p50');
    expect(html).toContain('120ms');
    expect(html).toContain('p95');
    expect(html).toContain('900ms');
    expect(html).toContain('p99');
    expect(html).toContain('1.4s');
    expect(html).toContain('openai');
    expect(html).toContain('16.7%');
  });

  test('renders a stable empty provider state', () => {
    const html = renderToStaticMarkup(
      <GatewayOpsPanel
        gateway={{
          requests_24h: 0,
          errors_24h: 0,
          error_rate_24h: 0,
          retries_24h: 0,
          input_tokens_24h: 0,
          output_tokens_24h: 0,
          cached_tokens_24h: 0,
          tokens_24h: 0,
          cost_usd_24h: 0,
          latency_ms: { p50: 0, p95: 0, p99: 0 },
          by_provider: [],
        }}
      />,
    );

    expect(html).toContain('No gateway requests in the last 24 hours.');
  });
});
