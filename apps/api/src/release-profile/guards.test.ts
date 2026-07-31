import { expect, test } from 'bun:test';

import { paymentsRouter } from '../billing/routes/payments';
import { subscriptionsRouter } from '../billing/routes/subscriptions';
import { RELEASE_PROFILE_UNAVAILABLE } from './runtime';

test('commercial routes reject before auth, account, Stripe, or repository work', async () => {
  const routes = [
    [paymentsRouter, '/purchase-credits', 'POST', 'commerce.purchase'],
    [paymentsRouter, '/auto-topup/configure', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/claim-per-seat', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/create-checkout-session', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/create-per-seat-checkout', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/sync-seat-quantity', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/create-inline-checkout', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/confirm-inline-checkout', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/create-portal-session', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/cancel-subscription', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/reactivate-subscription', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/schedule-downgrade', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/cancel-scheduled-change', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/sync-subscription', 'POST', 'commerce.settlement'],
    [subscriptionsRouter, '/proration-preview', 'GET', 'commerce.settlement'],
    [subscriptionsRouter, '/checkout-session/test-session', 'GET', 'commerce.settlement'],
    [subscriptionsRouter, '/confirm-checkout-session', 'POST', 'commerce.settlement'],
  ] as const;

  for (const [router, path, method, capability] of routes) {
    const response = await router.request(path, { method });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: RELEASE_PROFILE_UNAVAILABLE, capability });
  }
});
