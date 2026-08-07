# `@openopc/developer-sdk`

Official TypeScript SDK for applications running as reviewed OpenOPC modules.
It exposes provider-neutral AI and payment APIs. Every call goes through the
OpenOPC platform gateway with a short-lived, operation-scoped capability token.

## Install

```bash
npm install @openopc/developer-sdk
```

Node.js 18 or newer and modern browsers with `fetch`, `URL`, `Headers`, and
Web Streams are supported.

## Browser module

```ts
import { createOpenOpcBrowserModuleClient } from '@openopc/developer-sdk';

export async function listApprovedModels(signal?: AbortSignal) {
  const openopc = await createOpenOpcBrowserModuleClient({ signal });
  return (await openopc.ai.models.list({ signal })).data;
}
```

The helper discovers the active OpenOPC Web host from the reviewed iframe
parent, then uses that exact origin for capability tokens and service requests.
It accepts no platform-origin override. Direct visits to optional custom
domains remain static and cannot initialize AI or payment access.

### Advanced manual composition

Existing integrations can continue to compose the lower-level clients when the
trusted host origin is already supplied by platform-owned code:

```ts
import {
  createOpenOpcBrowserCapabilityTokenAdapter,
  createOpenOpcModuleClient,
} from '@openopc/developer-sdk';

export function createModuleSdk(platformOrigin: string) {
  return createOpenOpcModuleClient({
    baseUrl: platformOrigin,
    getCapabilityToken: createOpenOpcBrowserCapabilityTokenAdapter({
      hostOrigin: platformOrigin,
      hostWindow: window.parent,
      eventTarget: window,
    }),
  });
}
```

Do not derive a manual `platformOrigin` from query parameters, arbitrary
messages, or module-controlled storage.

## AI

- `openopc.ai.models.list()` lists models approved for the current installation.
- `openopc.ai.chat.create(input)` creates a non-streaming completion.
- `openopc.ai.chat.create({ ...input, stream: true })` returns an
  `AsyncIterable<OpenOpcChatChunk>`.

The request cannot select a provider, base URL, API key, or custom
authorization header. Provider credentials remain in the platform gateway.

### Images

Image generation is also platform-mediated. The SDK exposes a provider-neutral
catalog, estimate-before-submit flow, idempotent asynchronous jobs, job events,
and project-scoped image assets:

```ts
const { data: models } = await openopc.ai.images.models.list();
const model = models[0];
if (!model) throw new Error('No approved image model is available');

const input = {
  prompt: 'A quiet coastal town at blue hour',
  reference_asset_ids: [],
  aspect_ratio: '16:9' as const,
  quality: 'standard' as const,
  output_count: 1,
};
const estimate = await openopc.ai.images.estimates.create({ model: model.id, input });
const { job } = await openopc.ai.images.jobs.create(
  {
    model: model.id,
    input,
    estimate: {
      estimate_id: estimate.estimate_id,
      estimate_token: estimate.estimate_token,
      max_approved_credits: estimate.max_approved_credits,
    },
  },
  crypto.randomUUID(),
);
```

Use `jobs.get()` or `jobs.events()` until the job reaches a terminal state,
then download the returned asset with `assets.download(assetId)`. Upload local
reference images with `assets.create(blob)`; the model catalog advertises when a
model accepts references, negative prompts, and seeds. Model identifiers are
opaque, short-lived capability-bound handles, not provider model names or
configuration identifiers. The SDK never accepts a provider URL, provider key,
or module-controlled network destination.

## Payments

```ts
const order = await openopc.payments.orders.create(
  {
    amount_minor: 990,
    currency: 'CNY',
    product_name: 'Module upgrade',
  },
  crypto.randomUUID(),
);

window.location.assign(order.checkout.url);
```

Use a stable 16-128 character idempotency key for each create/refund intent.
Modules can create and read orders and request refunds. Merchant credentials,
provider callbacks, settlement, and payout controls are intentionally absent.

## Request lifecycle

Every high-level AI and payment method accepts a final optional
`OpenOpcRequestOptions` argument with `signal` and `timeoutMs`. The same signal
is applied to capability-token acquisition, the platform fetch, response-body
reading, and streaming iteration. Aborting it also removes the browser bridge's
pending message listener.

Normal requests default to 30 seconds and streaming chat defaults to 5 minutes.
Set `timeoutMs` once on `createOpenOpcModuleClient` to override both defaults, or
set it on one request. Values must be between 1 ms and 10 minutes.

## Errors

- `OpenOpcModuleProtocolError` means the module request or platform response
  violated the public protocol.
- `OpenOpcModuleServiceError` contains a stable platform error `code` and HTTP
  `status` without exposing upstream provider details.
- `OpenOpcModuleRequestError` reports a provider-neutral lifecycle code:
  `OPENOPC_MODULE_REQUEST_ABORTED`, `OPENOPC_MODULE_REQUEST_TIMEOUT`, or
  `OPENOPC_MODULE_REQUEST_FAILED`.
- `OpenOpcBrowserCapabilityTokenProtocolError` means browser bridge setup or an
  operation request is invalid.
- `OpenOpcBrowserModuleBootstrapProtocolError` means the one-call helper was
  used outside a reviewed iframe or received an invalid bootstrap response.

Capability tokens are short-lived. Do not persist, log, forward, or expose them
to another frame, origin, installation, project, or user.

See [`examples/browser-module.ts`](./examples/browser-module.ts) for a complete
initialization function.
