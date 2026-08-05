# OpenOPC Browser Module Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox - [ ] syntax for tracking.

**Goal:** Let a reviewed sandboxed Web module create the official OpenOPC AI/payment client without receiving or supplying a platform origin, while preserving the existing Web, Desktop, capability-token, and custom-domain boundaries.

**Architecture:** Add a secret-free v1 postMessage discovery handshake. The SDK derives the platform origin from the accepted parent MessageEvent, the Web host answers only the exact iframe source and immutable release origin, and the browser reaches only same-parent /v1/module-services routes through a route-scoped CORS policy. The launch descriptor and @kortix/sdk public surface remain unchanged.

**Tech Stack:** TypeScript, Bun test, React/Next.js, Hono, Electron policy tests, Playwright, pnpm on Windows.

**Approved design:** docs/superpowers/specs/2026-08-04-openopc-browser-module-bootstrap-design.md

## Global Constraints

- Work only in the existing E:/code/agentk/suna-studio-platform worktree on design/desktop-release-deferred.
- Preserve every pre-existing tracked and untracked change. Never reset, clean, stash, or overwrite unrelated work.
- Do not read or modify docs/superpowers/plans/2026-08-01-openopc-developer-sdk-newapi-zpay.md.
- Do not stage, commit, push, merge, publish, deploy, rebuild Desktop, change DNS, or call live AI/payment providers in this implementation slice.
- The generic commit steps from writing-plans are intentionally replaced with explicit no-commit checkpoints because the user has not authorized Git mutation beyond working-tree edits.
- Use apply_patch for manual edits and pnpm.cmd or npm.cmd for Windows commands.
- Capture a real RED result before each behavior implementation. Do not skip, weaken, delete, or filter away a failing test.
- Keep createOpenOpcModuleClient and createOpenOpcBrowserCapabilityTokenAdapter backward-compatible.
- Add no origin override to createOpenOpcBrowserModuleClient.
- Bootstrap accepts only a canonical HTTPS parent origin and protocol version v1.
- The wildcard postMessage target is allowed only for the secret-free bootstrap request. Every host response targets the exact module origin.
- AI and payment remain platform-owned gateways. Module code receives no NewAPI, Z-Pay, Alipay, WeChat, merchant, signing, or internal service credential.
- Direct custom-domain visits remain static and receive neither bootstrap nor capability tokens.
- Canonical release origins receive CORS only under /v1/module-services. Do not expand the global API CORS allowlist.
- Add no runtime dependency and do not change pnpm-lock.yaml.
- Append coordination and evidence to packages/sdk/PROGRESS.md without deleting, renumbering, or rewriting existing entries.

## File Map

### Create

- packages/openopc-developer-sdk/src/browser-module-bootstrap.ts
  Owns the public module-side v1 bootstrap protocol, lifecycle cleanup, trusted parent-origin discovery, and one-call client constructor.
- packages/openopc-developer-sdk/src/browser-module-bootstrap.test.ts
  Proves the public bootstrap contract, spoof rejection, timeout/abort behavior, cleanup, and constructed AI request.
- packages/openopc-developer-sdk/src/index.test.ts
  Proves the additive browser constructor is reachable from the package root.
- apps/web/src/features/project-modules/module-bootstrap-bridge.ts
  Owns the host-side exact request parser and exact-origin bootstrap response.
- apps/web/src/features/project-modules/module-bootstrap-bridge.test.ts
  Proves host origin/source/schema/version enforcement and listener cleanup.
- apps/api/src/module-services/browser-cors.ts
  Owns canonical release-origin recognition and the non-credentialed, module-service-only Hono middleware.
- apps/api/src/module-services/browser-cors.test.ts
  Proves canonical origin acceptance, hostile origin rejection, preflight headers, route scoping, and ordinary Web CORS preservation.
- apps/web/scripts/e2e/fixtures/module-bootstrap-browser-fixture.ts
  Browser bundle entry that runs the real SDK helper and real Web bootstrap/token bridges in separate parent/module roles.
- apps/web/scripts/e2e/module-bootstrap-browser-smoke.ts
  Playwright two-origin HTTPS fixture with CSP, CORS preflight, credential omission, attacker-parent, and direct-custom-domain assertions.

### Modify

- packages/openopc-developer-sdk/src/index.ts
  Exports the additive constructor, error, options, and protocol message types.
- packages/openopc-developer-sdk/README.md
  Leads with one-call initialization and retains manual composition as the advanced path.
- packages/openopc-developer-sdk/examples/browser-module.ts
  Typechecks the new default initialization path without a platform-origin argument.
- packages/openopc-developer-sdk/scripts/smoke-install.mjs
  Verifies the packed tarball exports the new constructor and bootstrap protocol error.
- apps/web/src/features/project-modules/project-module-host.ts
  Attaches and cleans up both bootstrap and capability-token bridges for the exact mounted iframe.
- apps/web/src/features/project-modules/project-module-host.test.ts
  Proves manifest/descriptor gating, combined cleanup, and bootstrap/token coexistence.
- apps/api/src/module-domains/host.ts
  Adds validated platform Web origins to connect-src while retaining all existing static-host policy.
- apps/api/src/module-domains/host.test.ts
  Proves exact CSP output and rejection of provider/wildcard origins.
- apps/api/src/index.ts
  Reuses the existing parsed module-host configuration and mounts route-scoped module-service CORS before global CORS.
- apps/web/package.json
  Adds the deterministic module-bootstrap browser smoke command.
- packages/sdk/PROGRESS.md
  Appends the in-progress claim and final RED/GREEN evidence.

### Verify Without Modification Unless A Test Finds A Regression

- apps/desktop-electron/src/app-policy.js
- apps/desktop-electron/src/app-policy.test.js
- apps/web/src/features/project-modules/module-service-bridge.ts
- apps/web/src/features/project-modules/module-service-bridge.test.ts
- apps/web/src/features/project-modules/project-module-host-page.tsx
- apps/web/next.config.ts

---

### Task 1: Public SDK Browser Bootstrap

**Files:**

- Create: packages/openopc-developer-sdk/src/browser-module-bootstrap.ts
- Create: packages/openopc-developer-sdk/src/browser-module-bootstrap.test.ts
- Create: packages/openopc-developer-sdk/src/index.test.ts
- Modify: packages/openopc-developer-sdk/src/index.ts
- Modify: packages/sdk/PROGRESS.md

**Interfaces:**

- Consumes: createOpenOpcModuleClient(options), createOpenOpcBrowserCapabilityTokenAdapter(options), OpenOpcModuleRequestError, OpenOpcModuleFetch, and OpenOpcModuleClient.
- Produces:

    export interface OpenOpcBrowserModuleBootstrapRequest {
      type: "openopc.module.bootstrap.request";
      requestId: string;
      sdkApiVersion: "v1";
    }

    export interface OpenOpcBrowserModuleBootstrapResponse {
      type: "openopc.module.bootstrap.response";
      requestId: string;
      sdkApiVersion: "v1";
    }

    export type OpenOpcBrowserModuleParentWindow =
      OpenOpcBrowserCapabilityTokenHostWindow & {
        postMessage(
          message: OpenOpcBrowserModuleBootstrapRequest,
          targetOrigin: string,
        ): void;
      };

    export interface OpenOpcBrowserModuleWindow
      extends OpenOpcBrowserCapabilityTokenEventTarget {
      readonly parent: OpenOpcBrowserModuleParentWindow;
    }

    export interface OpenOpcBrowserModuleClientOptions {
      window?: OpenOpcBrowserModuleWindow;
      signal?: AbortSignal;
      bootstrapTimeoutMs?: number;
      timeoutMs?: number;
      fetch?: OpenOpcModuleFetch;
      requestId?: () => string;
    }

    export class OpenOpcBrowserModuleBootstrapProtocolError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "OpenOpcBrowserModuleBootstrapProtocolError";
      }
    }

    export function createOpenOpcBrowserModuleClient(
      options?: OpenOpcBrowserModuleClientOptions,
    ): Promise<OpenOpcModuleClient>;

- Invariant: options has no baseUrl, hostOrigin, platformOrigin, URL, query, fragment, or storage override.

- [ ] **Step 1: Record the active work without changing an existing progress row**

Append this session header to packages/sdk/PROGRESS.md:

    ### 2026-08-04 - OpenOPC browser module bootstrap (Codex, IN PROGRESS)

    Approved spec:
    docs/superpowers/specs/2026-08-04-openopc-browser-module-bootstrap-design.md

    Scope: trusted iframe bootstrap, route-scoped browser transport, SDK docs,
    and deterministic browser verification. No publish, Desktop rebuild, push,
    merge, deployment, DNS, or live provider call is authorized.

Run:

    git status --short --branch

Expected: the existing dirty files remain present and only the approved spec,
plan, and progress append are attributable to this task.

- [ ] **Step 2: Write the failing SDK contract tests**

Create browser-module-bootstrap.test.ts with a fake child window that records
listeners and parent postMessage calls. The first tests must exercise the public
behavior rather than an internal parser:

    import { describe, expect, spyOn, test } from "bun:test";
    import {
      OpenOpcBrowserModuleBootstrapProtocolError,
      createOpenOpcBrowserModuleClient,
      type OpenOpcBrowserModuleClientOptions,
      type OpenOpcBrowserModuleWindow,
    } from "./browser-module-bootstrap";

    const PLATFORM_ORIGIN = "https://app.openopc.example";
    const REQUEST_ID = "10000000-0000-4000-8000-000000000001";

    test("discovers the parent origin and uses it for token and HTTP requests", async () => {
      const requests: Array<{ message: unknown; targetOrigin: string }> = [];
      const fetches: string[] = [];
      const browser = createFakeChildWindow((message, targetOrigin, child) => {
        requests.push({ message, targetOrigin });
        queueMicrotask(() => {
          child.dispatch({
            origin: PLATFORM_ORIGIN,
            source: child.parent,
            data: {
              type: "openopc.module.bootstrap.response",
              requestId: REQUEST_ID,
              sdkApiVersion: "v1",
            },
          });
        });
      });

      const client = await createOpenOpcBrowserModuleClient({
        window: browser,
        requestId: sequentialIds(
          REQUEST_ID,
          "10000000-0000-4000-8000-000000000002",
        ),
        fetch: async (input) => {
          fetches.push(String(input));
          return Response.json({ data: [] });
        },
      });

      browser.answerNextToken("v4.public.test-token");
      await client.ai.models.list();

      expect(requests[0]).toEqual({
        targetOrigin: "*",
        message: {
          type: "openopc.module.bootstrap.request",
          requestId: REQUEST_ID,
          sdkApiVersion: "v1",
        },
      });
      expect(fetches).toEqual([
        "https://app.openopc.example/v1/module-services/ai/models",
      ]);
    });

    test("ignores spoofed responses and cleans up after the exact response", async () => {
      const browser = createFakeChildWindow();
      const pending = createOpenOpcBrowserModuleClient({
        window: browser,
        requestId: () => REQUEST_ID,
      });

      browser.dispatch({
        origin: "https://attacker.example",
        source: {},
        data: {
          type: "openopc.module.bootstrap.response",
          requestId: REQUEST_ID,
          sdkApiVersion: "v1",
        },
      });
      expect(browser.listenerCount()).toBe(1);

      browser.dispatch({
        origin: PLATFORM_ORIGIN,
        source: browser.parent,
        data: {
          type: "openopc.module.bootstrap.response",
          requestId: REQUEST_ID,
          sdkApiVersion: "v1",
        },
      });
      await pending;
      expect(browser.listenerCount()).toBe(0);
    });

    test("clears the bootstrap timer exactly once on success", async () => {
      const clearTimer = spyOn(globalThis, "clearTimeout");
      try {
        const browser = createFakeChildWindow((_message, _targetOrigin, child) => {
          queueMicrotask(() => {
            child.dispatch({
              origin: PLATFORM_ORIGIN,
              source: child.parent,
              data: {
                type: "openopc.module.bootstrap.response",
                requestId: REQUEST_ID,
                sdkApiVersion: "v1",
              },
            });
          });
        });
        await createOpenOpcBrowserModuleClient({
          window: browser,
          requestId: () => REQUEST_ID,
        });
        expect(clearTimer).toHaveBeenCalledTimes(1);
        expect(browser.listenerCount()).toBe(0);
      } finally {
        clearTimer.mockRestore();
      }
    });

    test("fails fast at top level and reports abort, timeout, and send failure", async () => {
      const topLevel = createFakeTopLevelWindow();
      await expect(
        createOpenOpcBrowserModuleClient({ window: topLevel }),
      ).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);

      const controller = new AbortController();
      controller.abort();
      await expect(
        createOpenOpcBrowserModuleClient({
          window: createFakeChildWindow(),
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "OPENOPC_MODULE_REQUEST_ABORTED" });

      await expect(
        createOpenOpcBrowserModuleClient({
          window: createFakeChildWindow(),
          bootstrapTimeoutMs: 1,
        }),
      ).rejects.toMatchObject({ code: "OPENOPC_MODULE_REQUEST_TIMEOUT" });

      await expect(
        createOpenOpcBrowserModuleClient({
          window: createThrowingChildWindow(),
        }),
      ).rejects.toMatchObject({ code: "OPENOPC_MODULE_REQUEST_FAILED" });
    });

    test("ignores unrelated messages but rejects a matching malformed response", async () => {
      const browser = createFakeChildWindow();
      const pending = createOpenOpcBrowserModuleClient({
        window: browser,
        requestId: () => REQUEST_ID,
      });

      browser.dispatch({
        origin: PLATFORM_ORIGIN,
        source: browser.parent,
        data: {
          type: "openopc.module.bootstrap.response",
          requestId: "10000000-0000-4000-8000-000000000009",
          sdkApiVersion: "v1",
        },
      });
      browser.dispatch({
        origin: PLATFORM_ORIGIN,
        source: browser.parent,
        data: { type: "unrelated.message", requestId: REQUEST_ID },
      });
      expect(browser.listenerCount()).toBe(1);

      browser.dispatch({
        origin: PLATFORM_ORIGIN,
        source: browser.parent,
        data: {
          type: "openopc.module.bootstrap.response",
          requestId: REQUEST_ID,
          sdkApiVersion: "v2",
        },
      });
      await expect(pending).rejects.toBeInstanceOf(
        OpenOpcBrowserModuleBootstrapProtocolError,
      );
      expect(browser.listenerCount()).toBe(0);
    });

    test("rejects exact-key and HTTPS violations that claim the active request", async () => {
      for (const event of [
        {
          origin: PLATFORM_ORIGIN,
          data: {
            type: "openopc.module.bootstrap.response",
            requestId: REQUEST_ID,
            sdkApiVersion: "v1",
            platformOrigin: "https://attacker.example",
          },
        },
        {
          origin: "http://app.openopc.example",
          data: {
            type: "openopc.module.bootstrap.response",
            requestId: REQUEST_ID,
            sdkApiVersion: "v1",
          },
        },
      ]) {
        const browser = createFakeChildWindow();
        const pending = createOpenOpcBrowserModuleClient({
          window: browser,
          requestId: () => REQUEST_ID,
        });
        browser.dispatch({ ...event, source: browser.parent });
        await expect(pending).rejects.toBeInstanceOf(
          OpenOpcBrowserModuleBootstrapProtocolError,
        );
        expect(browser.listenerCount()).toBe(0);
      }
    });

    test("cleans listeners and the timer on abort, timeout, and send failure", async () => {
      const abortController = new AbortController();
      const aborting = createFakeChildWindow();
      const pendingAbort = createOpenOpcBrowserModuleClient({
        window: aborting,
        signal: abortController.signal,
        requestId: () => REQUEST_ID,
      });
      expect(aborting.listenerCount()).toBe(1);
      abortController.abort();
      await expect(pendingAbort).rejects.toMatchObject({
        code: "OPENOPC_MODULE_REQUEST_ABORTED",
      });
      expect(aborting.listenerCount()).toBe(0);

      const timingOut = createFakeChildWindow();
      const pendingTimeout = createOpenOpcBrowserModuleClient({
        window: timingOut,
        bootstrapTimeoutMs: 1,
        requestId: () => REQUEST_ID,
      });
      await expect(pendingTimeout).rejects.toMatchObject({
        code: "OPENOPC_MODULE_REQUEST_TIMEOUT",
      });
      expect(timingOut.listenerCount()).toBe(0);

      const sending = createThrowingChildWindow();
      const pendingSend = createOpenOpcBrowserModuleClient({
        window: sending,
        requestId: () => REQUEST_ID,
      });
      await expect(pendingSend).rejects.toMatchObject({
        code: "OPENOPC_MODULE_REQUEST_FAILED",
      });
      expect(sending.listenerCount()).toBe(0);
    });

    test("rejects unknown options, invalid timeout, and invalid request IDs before sending", async () => {
      const browser = createFakeChildWindow();
      await expect(
        createOpenOpcBrowserModuleClient({
          window: browser,
          platformOrigin: PLATFORM_ORIGIN,
        } as never),
      ).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);
      await expect(
        createOpenOpcBrowserModuleClient({
          window: browser,
          bootstrapTimeoutMs: 0,
        }),
      ).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);
      await expect(
        createOpenOpcBrowserModuleClient({
          window: browser,
          requestId: () => "10000000-0000-4000-A000-000000000001",
        }),
      ).rejects.toBeInstanceOf(OpenOpcBrowserModuleBootstrapProtocolError);
      expect(browser.parentPosts()).toHaveLength(0);
      expect(browser.listenerCount()).toBe(0);
    });

    test("keeps origin overrides out of the public options type", () => {
      const options: OpenOpcBrowserModuleClientOptions = {
        // @ts-expect-error platformOrigin is intentionally not public.
        platformOrigin: PLATFORM_ORIGIN,
      };
      expect(options).toBeDefined();
    });

The test helper must expose listenerCount, dispatch, parent postMessage records,
and answerNextToken. It must use a sequence of canonical UUIDs so bootstrap and
token requests cannot accidentally share an ID.

Build the fake around one listener set and one queued token:

    interface FakeMessageEvent {
      origin: string;
      source: unknown;
      data: unknown;
    }

    interface FakeChildWindow extends OpenOpcBrowserModuleWindow {
      dispatch(event: FakeMessageEvent): void;
      listenerCount(): number;
      parentPosts(): Array<{ message: unknown; targetOrigin: string }>;
      answerNextToken(token: string): void;
    }

    function sequentialIds(...ids: string[]): () => string {
      let index = 0;
      return () => {
        const id = ids[index++];
        if (!id) throw new Error("No fake request ID remains");
        return id;
      };
    }

    function createFakeChildWindow(
      onPost?: (
        message: unknown,
        targetOrigin: string,
        child: FakeChildWindow,
      ) => void,
    ): FakeChildWindow {
      const listeners = new Set<(event: FakeMessageEvent) => void>();
      const parentPosts: Array<{ message: unknown; targetOrigin: string }> = [];
      let queuedToken: string | null = null;
      let child: FakeChildWindow;
      const parent = {
        postMessage(message: unknown, targetOrigin: string) {
          parentPosts.push({ message, targetOrigin });
          const record = message as Record<string, unknown>;
          if (
            record.type === "openopc.module-service.token.request" &&
            queuedToken
          ) {
            const token = queuedToken;
            queuedToken = null;
            queueMicrotask(() => {
              child.dispatch({
                origin: PLATFORM_ORIGIN,
                source: parent,
                data: {
                  type: "openopc.module-service.token.response",
                  requestId: record.requestId,
                  token,
                  expiresAt: new Date(Date.now() + 120_000).toISOString(),
                },
              });
            });
            return;
          }
          onPost?.(message, targetOrigin, child);
        },
      };
      child = {
        parent,
        addEventListener(_type, listener) {
          listeners.add(listener);
        },
        removeEventListener(_type, listener) {
          listeners.delete(listener);
        },
        dispatch(event) {
          for (const listener of [...listeners]) listener(event);
        },
        listenerCount: () => listeners.size,
        parentPosts: () => [...parentPosts],
        answerNextToken(token) {
          queuedToken = token;
        },
      };
      return child;
    }

    function createFakeTopLevelWindow(): FakeChildWindow {
      const child = createFakeChildWindow();
      Object.defineProperty(child, "parent", { value: child });
      return child;
    }

    function createThrowingChildWindow(): FakeChildWindow {
      const child = createFakeChildWindow();
      Object.defineProperty(child, "parent", {
        value: {
          postMessage() {
            throw new Error("send failed");
          },
        },
      });
      return child;
    }

- [ ] **Step 3: Run the SDK test and capture RED**

Run:

    pnpm.cmd --filter @openopc/developer-sdk exec bun test src/browser-module-bootstrap.test.ts

Expected RED: module resolution fails because browser-module-bootstrap.ts and
createOpenOpcBrowserModuleClient do not exist. Record the exact failing count and
message in the progress entry.

- [ ] **Step 4: Implement strict bootstrap discovery**

Create browser-module-bootstrap.ts with these constants and validation rules:

    import {
      createOpenOpcBrowserCapabilityTokenAdapter,
      type OpenOpcBrowserCapabilityTokenEventTarget,
      type OpenOpcBrowserCapabilityTokenHostWindow,
    } from "./browser-capability-token.js";
    import {
      createOpenOpcModuleClient,
      type OpenOpcModuleClient,
      type OpenOpcModuleFetch,
    } from "./client.js";
    import { OpenOpcModuleRequestError } from "./errors.js";

    const REQUEST_TYPE = "openopc.module.bootstrap.request" as const;
    const RESPONSE_TYPE = "openopc.module.bootstrap.response" as const;
    const SDK_API_VERSION = "v1" as const;
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;
    const MAX_BOOTSTRAP_TIMEOUT_MS = 30_000;
    const OPTION_KEYS = new Set([
      "window",
      "signal",
      "bootstrapTimeoutMs",
      "timeoutMs",
      "fetch",
      "requestId",
    ]);

Use an exact response parser:

    function isBootstrapResponse(
      value: unknown,
      requestId: string,
    ): value is OpenOpcBrowserModuleBootstrapResponse {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return (
        Object.keys(record).sort().join(",") ===
          "requestId,sdkApiVersion,type" &&
        record.type === RESPONSE_TYPE &&
        record.requestId === requestId &&
        record.sdkApiVersion === SDK_API_VERSION
      );
    }

    function identifiesBootstrapResponse(
      value: unknown,
      requestId: string,
    ): boolean {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return record.type === RESPONSE_TYPE && record.requestId === requestId;
    }

Validate the accepted MessageEvent origin without reading any payload URL:

    function canonicalHttpsOrigin(value: string): string | null {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.port &&
          url.origin === value
        )
          ? url.origin
          : null;
      } catch {
        return null;
      }
    }

Implement discoverPlatformOrigin so it:

1. validates exact option keys and function/object types;
2. resolves options.window or the browser global window without touching the
   global during module import;
3. rejects when parent and child are the same object;
4. installs the message and abort listeners before postMessage;
5. ignores messages from another source or without the outstanding request ID;
6. rejects a matching malformed response or non-HTTPS event.origin with
   OpenOpcBrowserModuleBootstrapProtocolError;
7. sends only the exact request to parent with targetOrigin "*";
8. maps pre-abort, timeout, and postMessage failure to OpenOpcModuleRequestError;
9. removes the timer and both listeners exactly once before resolve or reject.

The response listener must distinguish an unrelated message from a malformed
message that claims the outstanding request. After the exact source check, use:

    if (!identifiesBootstrapResponse(event.data, requestId)) return;
    const origin = canonicalHttpsOrigin(event.origin);
    if (!origin || !isBootstrapResponse(event.data, requestId)) {
      finishProtocolError("OpenOPC browser bootstrap response is invalid");
      return;
    }
    finishResolve(origin);

`finishProtocolError`, lifecycle-error rejection, and successful resolution all
call the same idempotent cleanup before settling. Generate and validate the
canonical request UUID before installing any listener or timer.

Use these private signatures so option validation and message lifecycle remain
separate from client composition:

    function resolveBrowserWindow(
      candidate?: OpenOpcBrowserModuleWindow,
    ): OpenOpcBrowserModuleWindow;

    function discoverPlatformOrigin(
      browserWindow: OpenOpcBrowserModuleWindow,
      options: OpenOpcBrowserModuleClientOptions,
    ): Promise<string>;

bootstrapTimeoutMs must be a safe integer from 1 through 30,000. signal must be
AbortSignal-like, fetch and requestId must be functions, and unknown option keys
must raise OpenOpcBrowserModuleBootstrapProtocolError before postMessage.

The public constructor must compose only existing public clients:

    export async function createOpenOpcBrowserModuleClient(
      options: OpenOpcBrowserModuleClientOptions = {},
    ): Promise<OpenOpcModuleClient> {
      const browserWindow = resolveBrowserWindow(options.window);
      const platformOrigin = await discoverPlatformOrigin(browserWindow, options);
      const getCapabilityToken = createOpenOpcBrowserCapabilityTokenAdapter({
        hostOrigin: platformOrigin,
        hostWindow: browserWindow.parent,
        eventTarget: browserWindow,
        requestId: options.requestId,
      });
      return createOpenOpcModuleClient({
        baseUrl: platformOrigin,
        getCapabilityToken,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      });
    }

- [ ] **Step 5: Run SDK bootstrap tests to GREEN**

Run:

    pnpm.cmd --filter @openopc/developer-sdk exec bun test src/browser-module-bootstrap.test.ts

Expected: all new bootstrap tests pass with zero failures. Confirm the spoofed
message leaves the promise pending until the exact parent response and confirm
all listener-count assertions execute.

- [ ] **Step 6: Export the additive public surface**

Modify src/index.ts to export:

    export {
      OpenOpcBrowserModuleBootstrapProtocolError,
      createOpenOpcBrowserModuleClient,
    } from "./browser-module-bootstrap.js";

    export type {
      OpenOpcBrowserModuleBootstrapRequest,
      OpenOpcBrowserModuleBootstrapResponse,
      OpenOpcBrowserModuleClientOptions,
      OpenOpcBrowserModuleParentWindow,
      OpenOpcBrowserModuleWindow,
    } from "./browser-module-bootstrap.js";

Create src/index.test.ts with the package-root assertion:

    import { expect, test } from "bun:test";

    import { createOpenOpcBrowserModuleClient } from "./index";

    test("exports the one-call browser module constructor", () => {
      expect(typeof createOpenOpcBrowserModuleClient).toBe("function");
    });

This catches an implementation file that exists but is missing from the package
root.

- [ ] **Step 7: Run the complete SDK unit suite**

Run:

    pnpm.cmd --filter @openopc/developer-sdk test

Expected: every existing client, contract, capability adapter, and new bootstrap
test passes; zero tests are skipped and zero fail.

- [ ] **Step 8: No-commit checkpoint**

Run:

    git status --short -- packages/openopc-developer-sdk packages/sdk/PROGRESS.md

Expected task-owned changes: the new SDK source/test, index export, and progress
append. Do not stage or commit them.

---

### Task 2: Exact Web Host Bootstrap Bridge

**Files:**

- Create: apps/web/src/features/project-modules/module-bootstrap-bridge.ts
- Create: apps/web/src/features/project-modules/module-bootstrap-bridge.test.ts
- Modify: apps/web/src/features/project-modules/project-module-host.ts
- Modify: apps/web/src/features/project-modules/project-module-host.test.ts

**Interfaces:**

- Consumes: server-issued ProjectModuleLaunchDescriptor, exact iframe Window,
  signed schema-v3 manifest, and existing attachModuleServiceBridge.
- Produces:

    export interface ModuleBootstrapRequest {
      type: "openopc.module.bootstrap.request";
      requestId: string;
      sdkApiVersion: "v1";
    }

    export interface ModuleBootstrapResponse {
      type: "openopc.module.bootstrap.response";
      requestId: string;
      sdkApiVersion: "v1";
    }

    export interface ModuleBootstrapMessageSource {
      postMessage(message: ModuleBootstrapResponse, targetOrigin: string): void;
    }

    export interface ModuleBootstrapBridgeMessage {
      origin: string;
      source: ModuleBootstrapMessageSource;
      data: unknown;
    }

    export interface ModuleBootstrapBridgeOptions {
      moduleOrigin: string;
      moduleSource: ModuleBootstrapMessageSource;
      sdkApiVersion: "v1";
    }

    export function createModuleBootstrapBridge(
      options: ModuleBootstrapBridgeOptions,
    ): { handleMessage(message: ModuleBootstrapBridgeMessage): boolean };

    export function attachModuleBootstrapBridge(
      target: Pick<Window, "addEventListener" | "removeEventListener">,
      options: ModuleBootstrapBridgeOptions,
    ): () => void;

- [ ] **Step 1: Write host bridge tests before source**

Create module-bootstrap-bridge.test.ts with one reusable exact-state harness:

    import { describe, expect, test } from "bun:test";

    import {
      attachModuleBootstrapBridge,
      createModuleBootstrapBridge,
      type ModuleBootstrapBridgeMessage,
      type ModuleBootstrapBridgeOptions,
      type ModuleBootstrapMessageSource,
    } from "./module-bootstrap-bridge";

    const MODULE_ORIGIN =
      "https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example";
    const REQUEST_ID = "10000000-0000-4000-8000-000000000001";

    function createBridgeHarness() {
      const posted: Array<{ message: unknown; targetOrigin: string }> = [];
      const source: ModuleBootstrapMessageSource = {
        postMessage(message, targetOrigin) {
          posted.push({ message, targetOrigin });
        },
      };
      const options: ModuleBootstrapBridgeOptions = {
        moduleOrigin: MODULE_ORIGIN,
        moduleSource: source,
        sdkApiVersion: "v1",
      };
      return {
        posted,
        source,
        options,
        bridge: createModuleBootstrapBridge(options),
      };
    }

    test("responds only to the exact module origin and source", () => {
      const harness = createBridgeHarness();
      expect(
        harness.bridge.handleMessage({
          origin: MODULE_ORIGIN,
          source: harness.source,
          data: {
            type: "openopc.module.bootstrap.request",
            requestId: REQUEST_ID,
            sdkApiVersion: "v1",
          },
        }),
      ).toBe(true);
      expect(harness.posted).toEqual([
        {
          targetOrigin: MODULE_ORIGIN,
          message: {
            type: "openopc.module.bootstrap.response",
            requestId: REQUEST_ID,
            sdkApiVersion: "v1",
          },
        },
      ]);
    });

    function hostileBootstrapMessages(
      source: ModuleBootstrapMessageSource,
    ): ModuleBootstrapBridgeMessage[] {
      const valid = {
        type: "openopc.module.bootstrap.request",
        requestId: "10000000-0000-4000-8000-000000000001",
        sdkApiVersion: "v1",
      };
      const foreignSource: ModuleBootstrapMessageSource = {
        postMessage() {},
      };
      return [
        { origin: MODULE_ORIGIN, source: foreignSource, data: valid },
        { origin: "https://attacker.example", source, data: valid },
        { origin: MODULE_ORIGIN, source, data: { ...valid, extra: true } },
        {
          origin: MODULE_ORIGIN,
          source,
          data: { ...valid, requestId: valid.requestId.toUpperCase() },
        },
        {
          origin: MODULE_ORIGIN,
          source,
          data: { ...valid, sdkApiVersion: "v2" },
        },
        {
          origin: MODULE_ORIGIN,
          source,
          data: { type: valid.type, requestId: valid.requestId },
        },
        {
          origin: MODULE_ORIGIN,
          source,
          data: { ...valid, type: "unrelated.message" },
        },
        { origin: "*", source, data: valid },
        { origin: MODULE_ORIGIN, source, data: null },
      ];
    }

    test("rejects foreign windows, foreign origins, malformed keys, and versions", () => {
      const harness = createBridgeHarness();
      for (const message of hostileBootstrapMessages(harness.source)) {
        expect(harness.bridge.handleMessage(message)).toBe(false);
      }
      expect(harness.posted).toEqual([]);
    });

    function createEventTargetHarness(): Pick<Window, "addEventListener" | "removeEventListener"> & {
      dispatch(event: MessageEvent): void;
      listenerCount(): number;
    } {
      const listeners = new Set<(event: MessageEvent) => void>();
      return {
        addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
          listeners.add(listener);
        },
        removeEventListener(_type: "message", listener: (event: MessageEvent) => void) {
          listeners.delete(listener);
        },
        dispatch(event: MessageEvent) {
          for (const listener of [...listeners]) listener(event);
        },
        listenerCount: () => listeners.size,
      } as unknown as Pick<Window, "addEventListener" | "removeEventListener"> & {
        dispatch(event: MessageEvent): void;
        listenerCount(): number;
      };
    }

    test("removes the exact listener during cleanup", () => {
      const harness = createBridgeHarness();
      const target = createEventTargetHarness();
      const cleanup = attachModuleBootstrapBridge(target, harness.options);
      expect(target.listenerCount()).toBe(1);
      cleanup();
      cleanup();
      expect(target.listenerCount()).toBe(0);
    });

    test("rejects invalid module origins before attaching a listener", () => {
      for (const moduleOrigin of [
        "*",
        "https://modules.openopc.example/path",
        "https://modules.openopc.example:8443",
        "http://modules.openopc.example",
      ]) {
        const target = createEventTargetHarness();
        expect(() =>
          attachModuleBootstrapBridge(target, {
            ...createBridgeHarness().options,
            moduleOrigin,
          }),
        ).toThrow();
        expect(target.listenerCount()).toBe(0);
      }

      const target = createEventTargetHarness();
      expect(() =>
        attachModuleBootstrapBridge(target, {
          ...createBridgeHarness().options,
          sdkApiVersion: "v2",
        } as never),
      ).toThrow();
      expect(target.listenerCount()).toBe(0);
    });

hostileBootstrapMessages must include an extra key, missing key, wrong message
type, uppercase UUID, wrong v2 version, wrong source, wrong origin,
wildcard-like origin, and non-object data.

- [ ] **Step 2: Run host bridge RED**

Run:

    pnpm.cmd --filter ./apps/web exec bun test src/features/project-modules/module-bootstrap-bridge.test.ts

Expected RED: the host bridge module cannot be resolved.

- [ ] **Step 3: Implement the pure host bridge**

Use the same exact request/response strings and canonical lowercase UUID regex
as the SDK. At construction, require sdkApiVersion to equal v1, require
moduleSource.postMessage to be a function, and validate moduleOrigin once:

    const REQUEST_TYPE = "openopc.module.bootstrap.request" as const;
    const RESPONSE_TYPE = "openopc.module.bootstrap.response" as const;
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    function immutableHttpsOrigin(value: string): string | null {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.port &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        )
          ? url.origin
          : null;
      } catch {
        return null;
      }
    }

The message handler is synchronous because it grants no capability:

    handleMessage(message) {
      if (
        message.origin !== moduleOrigin ||
        message.source !== options.moduleSource ||
        !isBootstrapRequest(message.data)
      ) {
        return false;
      }
      message.source.postMessage(
        {
          type: RESPONSE_TYPE,
          requestId: message.data.requestId,
          sdkApiVersion: options.sdkApiVersion,
        },
        moduleOrigin,
      );
      return true;
    }

attachModuleBootstrapBridge must add one message listener and return an
idempotent cleanup that removes that exact function.

- [ ] **Step 4: Run pure bridge tests to GREEN**

Run:

    pnpm.cmd --filter ./apps/web exec bun test src/features/project-modules/module-bootstrap-bridge.test.ts

Expected: all exact-origin, exact-window, exact-schema, version, and cleanup
tests pass with zero failures.

- [ ] **Step 5: Write failing production-composition assertions**

Extend project-module-host.test.ts before modifying project-module-host.ts:

    const BOOTSTRAP_REQUEST_ID =
      "60000000-0000-4000-8000-000000000006";

    function bootstrapRequest(source: unknown, overrides: Record<string, unknown> = {}) {
      return {
        origin: ORIGIN,
        source,
        data: {
          type: "openopc.module.bootstrap.request",
          requestId: BOOTSTRAP_REQUEST_ID,
          sdkApiVersion: "v1",
          ...overrides,
        },
      } as MessageEvent;
    }

Extend the existing createEventTarget return value; createHarness already
returns this object:

    listenerCount: () => listeners.size,

    test("attaches bootstrap and capability bridges for one matching v1 manifest", async () => {
      const harness = createHarness();
      expect(harness.eventTarget.listenerCount()).toBe(2);
      harness.eventTarget.dispatch(
        bootstrapRequest(harness.moduleSource),
      );
      expect(harness.posted[0]).toEqual({
        targetOrigin: ORIGIN,
        message: {
          type: "openopc.module.bootstrap.response",
          requestId: BOOTSTRAP_REQUEST_ID,
          sdkApiVersion: "v1",
        },
      });

      harness.eventTarget.dispatch(request(harness.moduleSource));
      await flushBridge();
      expect(harness.issueCapability).toHaveBeenCalledTimes(1);
      expect(harness.posted[1].message).toMatchObject({
        type: "openopc.module-service.token.response",
      });

      harness.cleanup();
      harness.cleanup();
      expect(harness.eventTarget.listenerCount()).toBe(0);
      harness.eventTarget.dispatch(bootstrapRequest(harness.moduleSource));
      harness.eventTarget.dispatch(request(harness.moduleSource));
      await flushBridge();
      expect(harness.posted).toHaveLength(2);
    });

    test("requires a signed sandboxed-web schema-v3 v1 manifest for bootstrap and token issuance", async () => {
      const missingOpenOpc = { ...MANIFEST };
      delete (missingOpenOpc as { openopc?: unknown }).openopc;
      const manifests = [
        missingOpenOpc,
        { ...MANIFEST, openopc: [] },
        {
          ...MANIFEST,
          openopc: { ...MANIFEST.openopc, sdkApiVersion: "v2" },
        },
        { ...MANIFEST, schemaVersion: 2 },
        {
          ...MANIFEST,
          execution: { mode: "native", entry: "web/index.html" },
        },
        { ...MANIFEST, id: "openopc.other" },
      ];

      for (const manifest of manifests) {
        const harness = createHarness({ manifest });
        harness.eventTarget.dispatch(bootstrapRequest(harness.moduleSource));
        harness.eventTarget.dispatch(request(harness.moduleSource));
        await flushBridge();
        expect(harness.posted).toEqual([]);
        expect(harness.issueCapability).not.toHaveBeenCalled();
        harness.cleanup();
      }
    });

- [ ] **Step 6: Run production composition RED**

Run:

    pnpm.cmd --filter ./apps/web exec bun test src/features/project-modules/project-module-host.test.ts

Expected RED: no bootstrap response is posted because the production host only
attaches the existing capability bridge.

- [ ] **Step 7: Compose both bridges in project-module-host.ts**

Keep manifestMatchesDescriptor and reuse the existing
isSandboxedWebModuleManifest parser. Add a narrow parser:

    import {
      type issueProjectModuleServiceCapability,
      isSandboxedWebModuleManifest,
      moduleServiceDeclarations,
    } from "./client";

    function manifestSdkApiVersion(
      manifest: unknown,
      descriptor: ProjectModuleLaunchDescriptor,
    ): "v1" | null {
      if (
        !manifestMatchesDescriptor(manifest, descriptor) ||
        !isSandboxedWebModuleManifest(manifest)
      ) {
        return null;
      }
      if (!isRecord(manifest.openopc)) return null;
      return manifest.openopc.sdkApiVersion === "v1" ? "v1" : null;
    }

Replace the existing declaration initialization so an invalid execution/schema
cannot retain token declarations merely because its openopc block looks valid:

    const sdkApiVersion = manifestSdkApiVersion(input.manifest, input.descriptor);
    const declarations = sdkApiVersion
      ? moduleServiceDeclarations(input.manifest)
      : [];
    const declaredServices = Object.fromEntries(
      declarations.map(({ service, operations }) => [service, operations]),
    );

Create bootstrap only for that valid matching v1 manifest, then create the
existing token bridge. Return one cleanup in reverse attachment order:

    const cleanups: Array<() => void> = [];
    if (sdkApiVersion) {
      cleanups.push(
        attachModuleBootstrapBridge(input.eventTarget, {
          moduleOrigin: input.descriptor.origin,
          moduleSource: input.moduleSource,
          sdkApiVersion,
        }),
      );
    }
    cleanups.push(
      attachModuleServiceBridge(input.eventTarget, {
        moduleOrigin: input.descriptor.origin,
        moduleSource: input.moduleSource,
        projectId: input.projectId,
        installationId: input.descriptor.installation_id,
        releaseId: input.descriptor.release_id,
        installRevision: input.descriptor.install_revision,
        declaredServices,
        issueToken: async ({ installationId, service, operation }) => {
          const capability = await input.issueCapability(
            input.projectId,
            installationId,
            { service, operations: [operation] },
          );
          return {
            token: capability.token,
            expiresAt: capability.expires_at,
          };
        },
        resolveCurrentState: async () => {
          const descriptor = await input.resolveLaunch();
          return {
            projectId: input.projectId,
            installationId: descriptor.installation_id,
            releaseId: descriptor.release_id,
            installRevision: descriptor.install_revision,
          };
        },
      }),
    );
    let cleaned = false;
    return () => {
      if (cleaned) return;
      cleaned = true;
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        cleanups[index]();
      }
    };

Do not change capability issuance, consent, rate limits, current-state
resolution, descriptor identity, or iframe rendering.

- [ ] **Step 8: Run all Web module bridge tests to GREEN**

Run:

    pnpm.cmd --filter ./apps/web exec bun test src/features/project-modules/module-bootstrap-bridge.test.ts src/features/project-modules/module-service-bridge.test.ts src/features/project-modules/project-module-host.test.ts src/features/project-modules/project-module-host-page.test.tsx

Expected: bootstrap, token bridge, production composition, and host view suites
all pass with zero failures.

- [ ] **Step 9: No-commit checkpoint**

Run:

    git status --short -- apps/web/src/features/project-modules

Expected task-owned changes: the two new bootstrap bridge files and the
production host source/test. Do not stage or commit.

---

### Task 3: Static CSP And Route-Scoped Module-Service CORS

**Files:**

- Modify: apps/api/src/module-domains/host.ts
- Modify: apps/api/src/module-domains/host.test.ts
- Create: apps/api/src/module-services/browser-cors.ts
- Create: apps/api/src/module-services/browser-cors.test.ts
- Modify: apps/api/src/index.ts

**Interfaces:**

- Consumes: ModuleAppHostConfiguration.baseDomain,
  the existing moduleAppHostConfiguration export from ./developer, and the
  existing global CORS middleware.
- Produces:

    export function canonicalModuleServiceBrowserOrigin(
      origin: string | undefined,
      configuration: ModuleAppHostConfiguration | null,
    ): string | null;

    export function createModuleServiceBrowserCors(
      configuration: ModuleAppHostConfiguration | null,
    ): MiddlewareHandler;

- [ ] **Step 1: Tighten the CSP expectation and capture RED**

Change the platform static-host assertion in host.test.ts from merely containing
connect-src self to requiring the validated Web origin:

    const csp = response.headers.get("content-security-policy");
    expect(csp).toContain(
      "connect-src 'self' https://app.openopc.example",
    );
    expect(csp).toContain(
      "frame-ancestors https://app.openopc.example",
    );
    expect(csp).not.toMatch(/new-api|z-pay|alipay|wechat|\*/i);

Extend the invalid-frame-origin test:

    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");

Run:

    pnpm.cmd --filter kortix-api exec bun test src/module-domains/host.test.ts

Expected RED: the current policy contains only connect-src self and omits the
validated OpenOPC Web origin.

- [ ] **Step 2: Implement the minimal CSP change**

In staticHostHeaders, derive both policies from the already validated
frameAncestors argument:

    const framePolicy =
      frameAncestors.length > 0 ? frameAncestors.join(" ") : "'none'";
    const connectPolicy = ["'self'", ...frameAncestors].join(" ");

Use:

    connect-src ${connectPolicy};
    frame-ancestors ${framePolicy}

inside the existing CSP string. Preserve every other directive and security
header byte-for-byte.

- [ ] **Step 3: Run static-host tests to GREEN**

Run:

    pnpm.cmd --filter kortix-api exec bun test src/module-domains/host.test.ts

Expected: custom-domain and canonical platform-host suites pass, invalid
operator origins remain absent, and no provider wildcard appears.

- [ ] **Step 4: Write route-scoped CORS tests**

Create browser-cors.test.ts around a small Hono app. Register the new
module-service middleware on /v1/module-services and descendants, then register
an existing-style global CORS middleware after it. Add these assertions:

    import { describe, expect, test } from "bun:test";
    import { Hono } from "hono";
    import { cors } from "hono/cors";

    import { parseModuleAppHostConfiguration } from "../module-domains/platform-host-config";
    import { createModuleServiceBrowserCors } from "./browser-cors";

    function createCorsHarness(includeReleaseInGlobal = false) {
      const RELEASE_ORIGIN =
        "https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example";
      const configuration = parseModuleAppHostConfiguration(
        "modules.openopc.example",
      );
      const app = new Hono();
      app.use("*", async (context, next) => {
        context.header("Vary", "Accept-Encoding");
        await next();
      });
      const moduleCors = createModuleServiceBrowserCors(configuration);
      app.use("/v1/module-services", moduleCors);
      app.use("/v1/module-services/*", moduleCors);
      app.use(
        "*",
        cors({
          origin: (origin) =>
            origin === "https://app.openopc.example" ||
            (includeReleaseInGlobal && origin === RELEASE_ORIGIN)
              ? origin
              : null,
          allowMethods: ["GET", "POST", "OPTIONS"],
          allowHeaders: ["Authorization", "Content-Type"],
          credentials: true,
        }),
      );
      app.get("/v1/module-services/ai/models", (context) =>
        context.json({ data: [] }),
      );
      app.get("/v1/accounts", (context) => context.json({ accounts: [] }));
      return { app, RELEASE_ORIGIN };
    }

Every test creates app with createCorsHarness. This reproduces production
middleware ordering and proves the module policy does not replace ordinary Web
CORS.

    test("allows only a canonical release origin on module-service routes", async () => {
      const { app, RELEASE_ORIGIN } = createCorsHarness();
      const response = await app.request("/v1/module-services/ai/models", {
        method: "OPTIONS",
        headers: {
          Origin: RELEASE_ORIGIN,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        RELEASE_ORIGIN,
      );
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, OPTIONS",
      );
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Authorization, Content-Type, Idempotency-Key",
      );
      expect(response.headers.get("access-control-max-age")).toBe("600");
      expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
    });

    test("adds noncredentialed CORS to an actual module-service response", async () => {
      const { app, RELEASE_ORIGIN } = createCorsHarness();
      const response = await app.request("/v1/module-services/ai/models", {
        headers: { Origin: RELEASE_ORIGIN, Authorization: "Bearer scoped" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        RELEASE_ORIGIN,
      );
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("vary")?.split(/,\s*/)).toEqual([
        "Accept-Encoding",
        "Origin",
      ]);
    });

    test("removes global credential CORS when an operator also listed the release origin", async () => {
      const { app, RELEASE_ORIGIN } = createCorsHarness(true);
      const response = await app.request("/v1/module-services/ai/models", {
        headers: { Origin: RELEASE_ORIGIN },
      });
      expect(response.headers.get("access-control-allow-origin")).toBe(
        RELEASE_ORIGIN,
      );
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    });

    test("does not grant module CORS on unrelated API routes", async () => {
      const { app, RELEASE_ORIGIN } = createCorsHarness();
      const response = await app.request("/v1/accounts", {
        headers: { Origin: RELEASE_ORIGIN },
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });

    test("rejects noncanonical and custom origins", async () => {
      const { app } = createCorsHarness();
      for (const origin of [
        "http://r-40000000-0000-4000-a000-000000000004.modules.openopc.example",
        "https://modules.openopc.example",
        "https://r-40000000-0000-4000-A000-000000000004.modules.openopc.example",
        "https://extra.r-40000000-0000-4000-a000-000000000004.modules.openopc.example",
        "https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example:8443",
        "https://user:pass@r-40000000-0000-4000-a000-000000000004.modules.openopc.example",
        "https://shop.customer.example",
        "https://r-40000000-0000-4000-a000-000000000004.modules.attacker.example",
      ]) {
        const response = await app.request(
          "/v1/module-services/ai/models",
          { headers: { Origin: origin } },
        );
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    test("preserves ordinary Web CORS behavior", async () => {
      const { app } = createCorsHarness();
      const response = await app.request("/v1/accounts", {
        headers: { Origin: "https://app.openopc.example" },
      });
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.openopc.example",
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
      );
    });

- [ ] **Step 5: Run CORS tests and capture RED**

Run:

    pnpm.cmd --filter kortix-api exec bun test src/module-services/browser-cors.test.ts

Expected RED: browser-cors.ts cannot be resolved.

- [ ] **Step 6: Implement canonical origin recognition**

Use the existing validated configuration rather than duplicating base-domain
parsing:

    import type { MiddlewareHandler } from "hono";

    import type { ModuleAppHostConfiguration } from "../module-domains/platform-host-config";

    const RELEASE_LABEL_RE =
      /^r-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

    export function canonicalModuleServiceBrowserOrigin(
      origin: string | undefined,
      configuration: ModuleAppHostConfiguration | null,
    ): string | null {
      if (!origin || !configuration) return null;
      try {
        const url = new URL(origin);
        const suffix = "." + configuration.baseDomain;
        if (
          url.protocol !== "https:" ||
          url.origin !== origin ||
          url.username ||
          url.password ||
          url.port ||
          !url.hostname.endsWith(suffix)
        ) {
          return null;
        }
        const releaseLabel = url.hostname.slice(0, -suffix.length);
        return RELEASE_LABEL_RE.test(releaseLabel) ? origin : null;
      } catch {
        return null;
      }
    }

- [ ] **Step 7: Implement non-credentialed Hono middleware**

The middleware must activate only for a recognized canonical module origin:

    const ALLOW_METHODS = "GET, POST, OPTIONS";
    const ALLOW_HEADERS = "Authorization, Content-Type, Idempotency-Key";

    function varyWithOrigin(value: string | null): string {
      const entries = (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!entries.some((entry) => entry.toLowerCase() === "origin")) {
        entries.push("Origin");
      }
      return entries.join(", ");
    }

    export function createModuleServiceBrowserCors(
      configuration: ModuleAppHostConfiguration | null,
    ): MiddlewareHandler {
      return async (context, next) => {
        const origin = canonicalModuleServiceBrowserOrigin(
          context.req.header("Origin"),
          configuration,
        );
        if (!origin) return next();

        const applyHeaders = () => {
          context.res.headers.set("Access-Control-Allow-Origin", origin);
          context.res.headers.set(
            "Vary",
            varyWithOrigin(context.res.headers.get("Vary")),
          );
          context.res.headers.delete("Access-Control-Allow-Credentials");
        };

        if (context.req.method === "OPTIONS") {
          context.header("Access-Control-Allow-Origin", origin);
          context.header("Access-Control-Allow-Methods", ALLOW_METHODS);
          context.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
          context.header("Access-Control-Max-Age", "600");
          context.header(
            "Vary",
            varyWithOrigin(context.res.headers.get("Vary")),
          );
          return context.body(null, 204);
        }

        await next();
        applyHeaders();
      };
    }

The post-next header application is required so the later global middleware
cannot add Access-Control-Allow-Credentials when an operator extra-origin list
also happens to contain a canonical module origin.

- [ ] **Step 8: Mount CORS before global middleware**

Extend the existing ./developer import to reuse its already parsed and frozen
configuration; remove parseModuleAppHostConfiguration from index.ts because
readyz no longer calls it:

    import {
      developerApp,
      moduleAppHostConfiguration,
      moduleCustomDomainHostApp,
      moduleCustomDomainInternalApp,
    } from "./developer";
    import { createModuleServiceBrowserCors } from "./module-services/browser-cors";

    const moduleServiceBrowserCors = createModuleServiceBrowserCors(
      moduleAppHostConfiguration,
    );

Before app.use("*", cors(...)), mount both exact base and descendant paths:

    app.use("/v1/module-services", moduleServiceBrowserCors);
    app.use("/v1/module-services/*", moduleServiceBrowserCors);

Change readyz to pass moduleAppHostConfiguration instead of reparsing the
environment value. Do not add canonical module origins to cloudOrigins,
localOrigins, extraOrigins, or PREVIEW_ORIGIN.

- [ ] **Step 9: Run focused API tests to GREEN**

Run:

    pnpm.cmd --filter kortix-api exec bun test src/module-domains/platform-host-config.test.ts src/module-domains/host.test.ts src/module-services/browser-cors.test.ts src/module-services/app.test.ts

Expected: configuration, static-host, CORS, and module-service suites all pass
with zero failures.

- [ ] **Step 10: Run API typecheck**

Run:

    pnpm.cmd --filter kortix-api typecheck

Expected: exit code 0 with the tested CORS headers represented without a type
escape. If this command is red, stop at the type error and diagnose the Hono API
before editing.

- [ ] **Step 11: No-commit checkpoint**

Run:

    git status --short -- apps/api/src/module-domains apps/api/src/module-services apps/api/src/index.ts

Expected task-owned changes: host source/test, browser CORS source/test, and
index mounting. Do not stage or commit.

---

### Task 4: Packed SDK Documentation And Two-Origin Browser Proof

**Files:**

- Modify: packages/openopc-developer-sdk/README.md
- Modify: packages/openopc-developer-sdk/examples/browser-module.ts
- Modify: packages/openopc-developer-sdk/scripts/smoke-install.mjs
- Create: apps/web/scripts/e2e/fixtures/module-bootstrap-browser-fixture.ts
- Create: apps/web/scripts/e2e/module-bootstrap-browser-smoke.ts
- Modify: apps/web/package.json

**Interfaces:**

- Consumes: createOpenOpcBrowserModuleClient,
  attachModuleBootstrapBridge, attachModuleServiceBridge, Playwright chromium,
  and Bun.build.
- Produces: pnpm.cmd --filter ./apps/web run test:e2e:module-bootstrap.

- [ ] **Step 1: Replace the primary browser example**

Make examples/browser-module.ts compile this public path:

    import { createOpenOpcBrowserModuleClient } from "@openopc/developer-sdk";

    export async function listApprovedModels(signal?: AbortSignal) {
      const openopc = await createOpenOpcBrowserModuleClient({ signal });
      return (await openopc.ai.models.list({ signal })).data;
    }

Do not accept platformOrigin. README must lead with the same constructor and
state that direct custom-domain visits are static. Keep a separate advanced
manual-composition section for existing callers; do not remove or deprecate the
manual exports.

- [ ] **Step 2: Make packed smoke require both new runtime exports**

Change smoke.mjs generation so its import includes:

    OpenOpcBrowserModuleBootstrapProtocolError,
    createOpenOpcBrowserModuleClient

Add:

    if (typeof createOpenOpcBrowserModuleClient !== "function") {
      throw new Error("browser module bootstrap missing");
    }
    if (
      new OpenOpcBrowserModuleBootstrapProtocolError("test").name !==
      "OpenOpcBrowserModuleBootstrapProtocolError"
    ) {
      throw new Error("browser bootstrap error missing");
    }

Do not call the helper in Node; packed smoke verifies importability while the
browser smoke verifies runtime behavior.

- [ ] **Step 3: Run docs typecheck and packed smoke**

Run:

    pnpm.cmd --filter @openopc/developer-sdk typecheck
    pnpm.cmd --filter @openopc/developer-sdk build
    pnpm.cmd --filter @openopc/developer-sdk run smoke:install

Expected: example typecheck exits 0, build emits declarations, and a temporary
consumer installs/imports the packed artifact successfully.

- [ ] **Step 4: Create the real browser fixture entry**

Start the fixture with the real production imports and fixed identities. The
release ID in MODULE_ORIGIN must exactly match RELEASE_ID:

    import {
      OpenOpcBrowserModuleBootstrapProtocolError,
      createOpenOpcBrowserModuleClient,
    } from "@openopc/developer-sdk";

    import { attachModuleBootstrapBridge } from "../../../src/features/project-modules/module-bootstrap-bridge";
    import { attachModuleServiceBridge } from "../../../src/features/project-modules/module-service-bridge";

    const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
    const INSTALLATION_ID = "20000000-0000-4000-8000-000000000002";
    const RELEASE_ID = "40000000-0000-4000-a000-000000000004";
    const MODULE_ORIGIN =
      `https://r-${RELEASE_ID}.modules.openopc.test`;
    const MODULE_PAGE = `${MODULE_ORIGIN}/fixture.html?role=module`;

Use a real Window-backed target that tracks only the listeners owned by the two
bridges:

    function createTrackedMessageTarget() {
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const target = {
        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          if (type === "message") listeners.add(listener);
          window.addEventListener(type, listener);
        },
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
          if (type === "message") listeners.delete(listener);
          window.removeEventListener(type, listener);
        },
      } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
      return { target, listenerCount: () => listeners.size };
    }

The fixture entry has three roles selected from the served script URL:

    const role = new URL(import.meta.url).searchParams.get("role");
    if (role === "host") startHost();
    if (role === "module") void startModule();
    if (role === "direct") void assertDirectVisitFails();

startHost creates an iframe without src, appends it, captures
iframe.contentWindow, attaches both real bridge functions, and only then sets
the module URL. The function also exposes deterministic counters and cleanup to
the Playwright driver:

    function startHost() {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
      const markFrameSettled = () => {
        if (iframe.src === MODULE_PAGE) {
          document.body.dataset.frameSettled = "yes";
        }
      };
      iframe.addEventListener("load", markFrameSettled);
      iframe.addEventListener("error", markFrameSettled);
      document.body.append(iframe);
      const moduleSource = iframe.contentWindow;
      if (!moduleSource) throw new Error("module Window unavailable");
      const tracked = createTrackedMessageTarget();
      let bootstrapRequests = 0;
      let tokenRequests = 0;
      const observeBootstrap = (event: MessageEvent) => {
        const data = event.data as Record<string, unknown> | null;
        if (
          event.origin === MODULE_ORIGIN &&
          event.source === moduleSource &&
          data?.type === "openopc.module.bootstrap.request"
        ) {
          bootstrapRequests += 1;
        }
      };
      tracked.target.addEventListener("message", observeBootstrap);

      const cleanupBootstrap = attachModuleBootstrapBridge(tracked.target, {
        moduleOrigin: MODULE_ORIGIN,
        moduleSource,
        sdkApiVersion: "v1",
      });
      const cleanupToken = attachModuleServiceBridge(tracked.target, {
        moduleOrigin: MODULE_ORIGIN,
        moduleSource,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        releaseId: RELEASE_ID,
        installRevision: 1,
        declaredServices: { ai: ["models.read"] },
        resolveCurrentState: async () => ({
          projectId: PROJECT_ID,
          installationId: INSTALLATION_ID,
          releaseId: RELEASE_ID,
          installRevision: 1,
        }),
        issueToken: async () => {
          tokenRequests += 1;
          return {
            token: "v4.public.browser-smoke",
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          };
        },
      });

      Object.assign(window, {
        __openOpcFixtureBootstrapRequests: () => bootstrapRequests,
        __openOpcFixtureTokenRequests: () => tokenRequests,
        __openOpcFixtureCleanup: () => {
          cleanupToken();
          cleanupBootstrap();
          tracked.target.removeEventListener("message", observeBootstrap);
          iframe.removeEventListener("load", markFrameSettled);
          iframe.removeEventListener("error", markFrameSettled);
          iframe.remove();
          document.body.dataset.cleanup =
            tracked.listenerCount() === 0 ? "ok" : "leaked";
        },
      });
      iframe.src = MODULE_PAGE;
      document.body.dataset.hostReady = "yes";
    }

startModule calls the real helper, lists models, and writes deterministic DOM
state:

    async function startModule() {
      try {
        const openopc = await createOpenOpcBrowserModuleClient();
        const result = await openopc.ai.models.list();
        document.body.dataset.result =
          result.data[0]?.id === "approved-model" ? "ok" : "bad-model";
      } catch (error) {
        document.body.dataset.result =
          error instanceof Error ? `error:${error.name}` : "error:unknown";
      }
    }

assertDirectVisitFails must not swallow an unexpected error:

    async function assertDirectVisitFails() {
      try {
        await createOpenOpcBrowserModuleClient();
        document.body.dataset.result = "unexpected-bootstrap";
      } catch (error) {
        document.body.dataset.result =
          error instanceof OpenOpcBrowserModuleBootstrapProtocolError
            ? "bootstrap-rejected"
            : "unexpected-error";
      }
    }

- [ ] **Step 5: Create the Playwright route-fulfilled HTTPS smoke**

Use these exact origins and one local assertion helper:

    import { fileURLToPath } from "node:url";
    import { chromium, type Route } from "playwright";

    const PLATFORM_ORIGIN = "https://app.openopc.test";
    const RELEASE_ID = "40000000-0000-4000-a000-000000000004";
    const MODULE_ORIGIN =
      `https://r-${RELEASE_ID}.modules.openopc.test`;
    const ATTACKER_ORIGIN = "https://attacker.openopc.test";
    const CUSTOM_ORIGIN = "https://module.customer.example";
    const SERVICE_PATH = "/v1/module-services/ai/models";

    function assert(condition: unknown, message: string): asserts condition {
      if (!condition) throw new Error(message);
    }

Bundle the real fixture and fail on any Bun.build diagnostic:

    const fixturePath = fileURLToPath(
      new URL("./fixtures/module-bootstrap-browser-fixture.ts", import.meta.url),
    );
    const build = await Bun.build({
      entrypoints: [fixturePath],
      target: "browser",
      format: "esm",
      minify: false,
    });
    if (!build.success || build.outputs.length !== 1) {
      throw new Error(build.logs.map(String).join("\n") || "fixture build failed");
    }
    const bundle = await build.outputs[0].text();

The context route is installed before any page is created. It must fulfill only
the four fixture origins and the one service path; every other request is
recorded as unexpected and answered 404. Use the real `Origin` and preflight
headers from `route.request()`:

    const counts = {
      preflight: 0,
      models: 0,
      modelCookies: [] as string[],
      unexpected: [] as string[],
    };
    const corsHeaders = {
      "access-control-allow-origin": MODULE_ORIGIN,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        "Authorization, Content-Type, Idempotency-Key",
      vary: "Origin",
    };

    async function installRoute(route: Route) {
      const request = route.request();
      const url = new URL(request.url());
      const isFixtureOrigin = [
        PLATFORM_ORIGIN,
        MODULE_ORIGIN,
        ATTACKER_ORIGIN,
        CUSTOM_ORIGIN,
      ].includes(url.origin);
      if (url.pathname === "/favicon.ico" && isFixtureOrigin) {
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      if (url.pathname === "/fixture.js" && isFixtureOrigin) {
        await route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: bundle,
        });
        return;
      }
      if (url.pathname === "/fixture.html" && isFixtureOrigin) {
        const role = url.searchParams.get("role");
        const headers =
          url.origin === MODULE_ORIGIN
            ? {
                "content-security-policy": [
                  "default-src 'self'",
                  "base-uri 'none'",
                  "object-src 'none'",
                  "script-src 'self'",
                  `connect-src 'self' ${PLATFORM_ORIGIN}`,
                  `frame-ancestors ${PLATFORM_ORIGIN}`,
                ].join("; "),
              }
            : {};
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          headers,
          body: `<body><script type="module" src="/fixture.js?role=${role}"></script></body>`,
        });
        return;
      }
      if (url.origin === PLATFORM_ORIGIN && url.pathname === SERVICE_PATH) {
        assert(request.headers().origin === MODULE_ORIGIN, "service origin mismatch");
        if (request.method() === "OPTIONS") {
          counts.preflight += 1;
          assert(
            request.headers()["access-control-request-method"] === "GET",
            "preflight method mismatch",
          );
          assert(
            request.headers()["access-control-request-headers"]
              ?.toLowerCase()
              .split(/,\s*/)
              .includes("authorization"),
            "preflight authorization header missing",
          );
          await route.fulfill({ status: 204, headers: corsHeaders, body: "" });
          return;
        }
        counts.models += 1;
        counts.modelCookies.push(request.headers().cookie ?? "");
        assert(
          request.headers().authorization === "Bearer v4.public.browser-smoke",
          "scoped authorization mismatch",
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: corsHeaders,
          body: JSON.stringify({
            data: [
              {
                id: "approved-model",
                object: "model",
                owned_by: "openopc",
              },
            ],
          }),
        });
        return;
      }
      counts.unexpected.push(`${request.method()} ${request.url()}`);
      await route.fulfill({ status: 404, body: "Not Found" });
    }

Run Chromium with `ignoreHTTPSErrors: true` and service workers blocked. Add a
secure app-origin cookie before navigation, then drive the allowed flow:

    const browser = await chromium.launch();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
    });
    await context.route("**/*", installRoute);
    await context.addCookies([
      { name: "openopc_session", value: "fixture", url: PLATFORM_ORIGIN },
    ]);
    const page = await context.newPage();
    await page.goto(`${PLATFORM_ORIGIN}/fixture.html?role=host`, {
      waitUntil: "domcontentloaded",
    });
    const moduleFrame = page.frameLocator(
      `iframe[src="${MODULE_ORIGIN}/fixture.html?role=module"]`,
    );
    await moduleFrame.locator('body[data-result="ok"]').waitFor({ timeout: 10_000 });
    const bootstrapRequests = await page.evaluate(() =>
      (window as unknown as {
        __openOpcFixtureBootstrapRequests: () => number;
      }).__openOpcFixtureBootstrapRequests(),
    );
    const tokenRequests = await page.evaluate(() =>
      (window as unknown as {
        __openOpcFixtureTokenRequests: () => number;
      }).__openOpcFixtureTokenRequests(),
    );
    assert(
      bootstrapRequests === 1,
      `expected one bootstrap request, got ${bootstrapRequests}`,
    );
    assert(tokenRequests === 1, `expected one token request, got ${tokenRequests}`);
    assert(counts.preflight === 1, `expected one preflight, got ${counts.preflight}`);
    assert(counts.models === 1, `expected one model request, got ${counts.models}`);
    assert(counts.modelCookies[0] === "", "module-service request sent a cookie");
    await page.evaluate(() =>
      (window as unknown as { __openOpcFixtureCleanup: () => void })
        .__openOpcFixtureCleanup(),
    );
    await page.locator('body[data-cleanup="ok"]').waitFor();

Drive the attacker and direct-domain cases without a sleep:

    const beforeDenied = { preflight: counts.preflight, models: counts.models };
    const attackerPage = await context.newPage();
    const cspMessages: string[] = [];
    attackerPage.on("console", (message) => cspMessages.push(message.text()));
    await attackerPage.goto(`${ATTACKER_ORIGIN}/fixture.html?role=host`, {
      waitUntil: "domcontentloaded",
    });
    await attackerPage
      .locator('body[data-frame-settled="yes"]')
      .waitFor({ timeout: 10_000 });
    const attackerBridgeCounts = await attackerPage.evaluate(() => ({
      bootstrap: (window as unknown as {
        __openOpcFixtureBootstrapRequests: () => number;
      }).__openOpcFixtureBootstrapRequests(),
      token: (window as unknown as {
        __openOpcFixtureTokenRequests: () => number;
      }).__openOpcFixtureTokenRequests(),
    }));
    assert(attackerBridgeCounts.bootstrap === 0, "attacker received bootstrap traffic");
    assert(attackerBridgeCounts.token === 0, "attacker parent obtained a token");
    assert(counts.preflight === beforeDenied.preflight, "attacker sent a preflight");
    assert(counts.models === beforeDenied.models, "attacker sent a model request");
    assert(
      cspMessages.some((message) => /frame-ancestors/i.test(message)),
      "attacker frame was not rejected by CSP",
    );
    await attackerPage.evaluate(() =>
      (window as unknown as { __openOpcFixtureCleanup: () => void })
        .__openOpcFixtureCleanup(),
    );
    await attackerPage.locator('body[data-cleanup="ok"]').waitFor();

    const directPage = await context.newPage();
    await directPage.goto(`${CUSTOM_ORIGIN}/fixture.html?role=direct`, {
      waitUntil: "domcontentloaded",
    });
    await directPage
      .locator('body[data-result="bootstrap-rejected"]')
      .waitFor({ timeout: 10_000 });
    assert(counts.preflight === beforeDenied.preflight, "direct page sent a preflight");
    assert(counts.models === beforeDenied.models, "direct page sent a model request");
    assert(counts.unexpected.length === 0, counts.unexpected.join("\n"));

Wrap every action after browser launch in `try`. In `finally`, first close every
created page with Promise.allSettled, then close the context, then the browser.
Do not let a later cleanup error replace the first assertion failure.

The complete module-bootstrap-browser-smoke.ts must therefore:

1. browser-bundle the fixture entry with Bun.build target browser and format esm;
2. launch Chromium and install a context-wide **/* route before navigation;
3. fulfill platform, module, attacker, and custom-domain pages at distinct HTTPS
   URLs without a local server or DNS;
4. return the actual bundle for each origin's fixture.js request;
5. set this module document response CSP:

       default-src 'self';
       base-uri 'none';
       object-src 'none';
       script-src 'self';
       connect-src 'self' https://app.openopc.test;
       frame-ancestors https://app.openopc.test

6. answer OPTIONS /v1/module-services/ai/models with exact non-credentialed
   CORS headers for the canonical module origin;
7. answer GET with one approved model only when Authorization equals the scoped
   token;
8. add an app-origin cookie before the fetch and assert the module-service
   request contains no Cookie header;
9. assert the real child frame reaches data-result="ok";
10. assert one bootstrap, one token, one preflight, and one model request occurred;
11. navigate an attacker parent that embeds the same module and assert CSP
    prevents successful bootstrap/model traffic;
12. navigate the direct custom-domain fixture and assert
    data-result="bootstrap-rejected";
13. close context and browser in finally.

Use page.frame or frameLocator with exact URLs; do not use time-based sleeps.
Wait on DOM data attributes and recorded request counts with bounded Playwright
assertions.

- [ ] **Step 6: Add and run the browser smoke command**

Add to apps/web/package.json:

    "test:e2e:module-bootstrap":
      "bun scripts/e2e/module-bootstrap-browser-smoke.ts"

Run:

    pnpm.cmd --filter ./apps/web run test:e2e:module-bootstrap

Expected: the script prints the allowed-flow, bootstrap/token counts,
attacker-parent, direct-domain, preflight, credential-omission, and cleanup
assertions, then exits 0. A console
CSP refusal for the attacker frame is expected evidence, not a skipped case.

- [ ] **Step 7: Verify Desktop policy remains unchanged**

Run:

    pnpm.cmd --filter @kortix/desktop-electron exec bun test src/app-policy.test.js

Expected: the existing desktop module-service suite accepts only the configured
Web origin under /v1/module-services and rejects provider origins and unrelated
paths. Do not modify Desktop source when these assertions pass.

- [ ] **Step 8: No-commit checkpoint**

Run:

    git status --short -- packages/openopc-developer-sdk apps/web/scripts/e2e apps/web/package.json apps/desktop-electron

Expected: SDK docs/smoke and Web browser fixture changes are present; Desktop
remains unchanged. Do not stage or commit.

---

### Task 5: Full Gates, Security Scan, And Evidence Closure

**Files:**

- Modify: packages/sdk/PROGRESS.md
- Verify every file listed in the File Map.

**Interfaces:**

- Consumes: all prior task outputs.
- Produces: fresh local verification evidence and an explicit source/package
  shippability verdict without publication or deployment claims.

- [x] **Step 1: Run focused suites together**

Run:

    pnpm.cmd --filter @openopc/developer-sdk test
    pnpm.cmd --filter ./apps/web exec bun test src/features/project-modules/module-bootstrap-bridge.test.ts src/features/project-modules/module-service-bridge.test.ts src/features/project-modules/project-module-host.test.ts src/features/project-modules/project-module-host-page.test.tsx
    pnpm.cmd --filter kortix-api exec bun test src/module-domains/platform-host-config.test.ts src/module-domains/host.test.ts src/module-services/browser-cors.test.ts src/module-services/app.test.ts
    pnpm.cmd --filter @kortix/desktop-electron exec bun test src/app-policy.test.js
    pnpm.cmd --filter ./apps/web run test:e2e:module-bootstrap

Expected: every command exits 0 with no skipped bootstrap, spoof, CSP, CORS,
Desktop, or browser-flow assertion.

- [x] **Step 2: Run package and broad regression gates**

Run:

    pnpm.cmd --filter @openopc/developer-sdk typecheck
    pnpm.cmd --filter @openopc/developer-sdk build
    pnpm.cmd --filter @openopc/developer-sdk run smoke:install
    pnpm.cmd --filter ./apps/web typecheck
    pnpm.cmd --filter kortix-api typecheck
    pnpm.cmd --filter @kortix/desktop-electron test
    pnpm.cmd --filter ./apps/web test
    pnpm.cmd --filter kortix-api test

Expected: every gate exits 0. Read and record actual test counts; an exit code
without executed test counts is not sufficient evidence.

- [x] **Step 3: Run formatting and whitespace gates on explicit paths**

Run:

    pnpm.cmd exec biome check packages/openopc-developer-sdk/src packages/openopc-developer-sdk/examples/browser-module.ts packages/openopc-developer-sdk/scripts/smoke-install.mjs apps/web/src/features/project-modules/module-bootstrap-bridge.ts apps/web/src/features/project-modules/module-bootstrap-bridge.test.ts apps/web/src/features/project-modules/project-module-host.ts apps/web/src/features/project-modules/project-module-host.test.ts apps/api/src/module-domains/host.ts apps/api/src/module-domains/host.test.ts apps/api/src/module-services/browser-cors.ts apps/api/src/module-services/browser-cors.test.ts apps/api/src/index.ts apps/web/scripts/e2e/fixtures/module-bootstrap-browser-fixture.ts apps/web/scripts/e2e/module-bootstrap-browser-smoke.ts apps/web/package.json

    git diff --check -- packages/openopc-developer-sdk apps/web/src/features/project-modules apps/api/src/module-domains apps/api/src/module-services apps/api/src/index.ts apps/web/scripts/e2e apps/web/package.json packages/sdk/PROGRESS.md docs/superpowers/specs/2026-08-04-openopc-browser-module-bootstrap-design.md docs/superpowers/plans/2026-08-04-openopc-browser-module-bootstrap.md

Expected: Biome reports every explicit file clean and git diff --check emits no
whitespace error.

- [x] **Step 4: Scan module-facing output for forbidden provider routes and origin overrides**

Run:

    rg -n "new-api|newapi|z-pay\.cn|alipay|wechat|api[_-]?key|merchant[_-]?key" packages/openopc-developer-sdk/src/browser-module-bootstrap.ts packages/openopc-developer-sdk/src/browser-capability-token.ts packages/openopc-developer-sdk/src/index.ts packages/openopc-developer-sdk/examples/browser-module.ts apps/web/src/features/project-modules/module-bootstrap-bridge.ts apps/web/scripts/e2e/fixtures/module-bootstrap-browser-fixture.ts

Expected: no match. An rg exit code of 1 means the forbidden strings are absent.
Negative tests and the transport's provider-key denylist are intentionally out
of scope for this lexical output scan because they must contain the rejected
identifiers to prove redaction and fail-closed behavior.

Run:

    rg -n "baseUrl|hostOrigin|platformOrigin" packages/openopc-developer-sdk/src/browser-module-bootstrap.ts packages/openopc-developer-sdk/examples/browser-module.ts

Expected: browser-module-bootstrap.ts may contain only its internal derived
platformOrigin local variable and composition arguments. The public options
interface and example contain no origin property or parameter.

- [x] **Step 5: Inspect the exact task diff and preserve unrelated changes**

Run:

    git diff -- packages/openopc-developer-sdk/src packages/openopc-developer-sdk/README.md packages/openopc-developer-sdk/examples packages/openopc-developer-sdk/scripts/smoke-install.mjs apps/web/src/features/project-modules/module-bootstrap-bridge.ts apps/web/src/features/project-modules/module-bootstrap-bridge.test.ts apps/web/src/features/project-modules/project-module-host.ts apps/web/src/features/project-modules/project-module-host.test.ts apps/api/src/module-domains/host.ts apps/api/src/module-domains/host.test.ts apps/api/src/module-services/browser-cors.ts apps/api/src/module-services/browser-cors.test.ts apps/api/src/index.ts apps/web/scripts/e2e apps/web/package.json packages/sdk/PROGRESS.md docs/superpowers/specs/2026-08-04-openopc-browser-module-bootstrap-design.md docs/superpowers/plans/2026-08-04-openopc-browser-module-bootstrap.md

For new untracked files, read each file directly because ordinary git diff does
not display it. Confirm:

- no launch descriptor or @kortix/sdk contract changed;
- no custom domain was added to CORS;
- no Access-Control-Allow-Credentials is emitted for module origins;
- no wildcard response target exists;
- every listener, timer, frame, context, and browser has cleanup;
- no unrelated dirty file was reformatted or reverted.

- [x] **Step 6: Append final evidence without rewriting prior progress**

Append one completed session entry to packages/sdk/PROGRESS.md. Include:

- the exact RED commands, failure counts, and failure reasons from Tasks 1-3;
- the exact GREEN commands and counts from Steps 1-3;
- browser smoke assertions observed;
- packed install/import result;
- forbidden-provider scan result;
- unchanged Desktop policy result;
- explicit statements that npm publication, live AI/payment, Desktop rebuild,
  push, merge, deployment, and DNS were not performed.

Do not prestate or round counts. Copy the actual command output values.

- [x] **Step 7: Re-run final integrity checks after the progress append**

Run:

    git diff --check -- packages/sdk/PROGRESS.md docs/superpowers/specs/2026-08-04-openopc-browser-module-bootstrap-design.md docs/superpowers/plans/2026-08-04-openopc-browser-module-bootstrap.md
    git status --short --branch

Expected: no whitespace errors; every pre-existing dirty path remains present;
only explicitly listed task files are newly changed.

- [x] **Step 8: Report the bounded verdict**

Report:

- Source/package shippable: YES only if every command above passed with fresh
  evidence.
- Public-beta production ready: NOT YET because this slice performs no npm
  publication, live NewAPI/payment flow, Desktop rebuild, DNS, merge, or
  deployment.
- Unverified surfaces: list only commands or live operations not executed, with
  the concrete reason each remained outside the approved scope.
- Git state: no file was staged, committed, pushed, merged, or deployed.

Do not offer a production claim based only on unit tests or the browser fixture.
