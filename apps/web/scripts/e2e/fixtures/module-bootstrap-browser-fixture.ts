import {
  OpenOpcBrowserModuleBootstrapProtocolError,
  createOpenOpcBrowserModuleClient,
} from '@openopc/developer-sdk';

import { attachModuleBootstrapBridge } from '../../../src/features/project-modules/module-bootstrap-bridge';
import { attachModuleServiceBridge } from '../../../src/features/project-modules/module-service-bridge';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = '20000000-0000-4000-8000-000000000002';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const PLATFORM_ORIGIN = 'https://app.openopc.localhost';
const MODULE_ORIGIN = `https://r-${RELEASE_ID}.modules.openopc.test`;
const MODULE_PAGE = `${MODULE_ORIGIN}/fixture.html?role=module`;
const PREFLIGHT_PROBE = `${PLATFORM_ORIGIN}/v1/module-services/preflight-probe`;

function createTrackedMessageTarget() {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const target = {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'message') listeners.add(listener);
      window.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'message') listeners.delete(listener);
      window.removeEventListener(type, listener);
    },
  } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
  return { target, listenerCount: () => listeners.size };
}

function startHost() {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
  iframe.setAttribute('allow', 'loopback-network');
  const markFrameSettled = () => {
    if (iframe.src === MODULE_PAGE) {
      document.body.dataset.frameSettled = 'yes';
    }
  };
  iframe.addEventListener('load', markFrameSettled);
  iframe.addEventListener('error', markFrameSettled);
  document.body.append(iframe);
  const moduleSource = iframe.contentWindow;
  if (!moduleSource) throw new Error('module Window unavailable');

  const tracked = createTrackedMessageTarget();
  let bootstrapRequests = 0;
  let tokenRequests = 0;
  const observeBootstrap = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (
      event.origin === MODULE_ORIGIN &&
      event.source === moduleSource &&
      data?.type === 'openopc.module.bootstrap.request'
    ) {
      bootstrapRequests += 1;
    }
  };
  tracked.target.addEventListener('message', observeBootstrap);

  const cleanupBootstrap = attachModuleBootstrapBridge(tracked.target, {
    moduleOrigin: MODULE_ORIGIN,
    moduleSource,
    sdkApiVersion: 'v1',
  });
  const cleanupToken = attachModuleServiceBridge(tracked.target, {
    moduleOrigin: MODULE_ORIGIN,
    moduleSource,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    releaseId: RELEASE_ID,
    installRevision: 1,
    declaredServices: { ai: ['models.read', 'text.stream'] },
    resolveCurrentState: async () => ({
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      releaseId: RELEASE_ID,
      installRevision: 1,
    }),
    issueToken: async () => {
      tokenRequests += 1;
      return {
        token: 'v4.public.browser-smoke',
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
      tracked.target.removeEventListener('message', observeBootstrap);
      iframe.removeEventListener('load', markFrameSettled);
      iframe.removeEventListener('error', markFrameSettled);
      iframe.remove();
      document.body.dataset.cleanup = tracked.listenerCount() === 0 ? 'ok' : 'leaked';
    },
  });
  iframe.src = MODULE_PAGE;
  document.body.dataset.hostReady = 'yes';
}

async function startModule() {
  try {
    const openopc = await createOpenOpcBrowserModuleClient();
    const result = await openopc.ai.models.list();
    const controller = new AbortController();
    const stream = await openopc.ai.chat.create(
      {
        model: 'approved-model',
        messages: [{ role: 'user', content: 'stream smoke' }],
        stream: true,
      },
      { signal: controller.signal },
    );
    const iterator = stream[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    if (!firstChunk.value || firstChunk.value.id !== 'browser-stream-1') {
      throw new Error('stream bootstrap chunk missing');
    }
    controller.abort();
    try {
      await iterator.next();
      throw new Error('stream abort was not observed');
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'OpenOpcModuleRequestError') throw error;
    }
    const probe = await fetch(PREFLIGHT_PROBE, {
      method: 'OPTIONS',
      headers: {
        Authorization: 'Bearer v4.public.browser-smoke',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'browser-preflight-probe',
      },
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (!probe.ok) throw new Error('preflight probe failed');
    document.body.dataset.result = result.data[0]?.id === 'approved-model' ? 'ok' : 'bad-model';
  } catch (error) {
    document.body.dataset.result = error instanceof Error ? `error:${error.name}` : 'error:unknown';
  }
}

async function assertDirectVisitFails() {
  try {
    await createOpenOpcBrowserModuleClient();
    document.body.dataset.result = 'unexpected-bootstrap';
  } catch (error) {
    document.body.dataset.result =
      error instanceof OpenOpcBrowserModuleBootstrapProtocolError
        ? 'bootstrap-rejected'
        : 'unexpected-error';
  }
}

const role = new URL(import.meta.url).searchParams.get('role');
if (role === 'host') startHost();
if (role === 'module') void startModule();
if (role === 'direct') void assertDirectVisitFails();
