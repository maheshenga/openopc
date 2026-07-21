import type {
  AutomationEvent,
  AutomationLease,
  AutomationStep,
  BrowserPolicy,
} from '@kortix/intelligence-contracts';
import { type Browser, type Page, chromium } from 'playwright';
import { createBrowserActionRunner } from './action-runner';
import { browserWorkerConfig } from './config';
import { createBrowserOriginGuard } from './origin-guard';

export async function runIsolatedBrowserRequest(input: {
  lease: AutomationLease;
  steps: readonly AutomationStep[];
  policy: BrowserPolicy;
  signal: AbortSignal;
  isSignedLeaseValid: (lease: AutomationLease) => Promise<boolean>;
  isLeaseCurrent: (lease: AutomationLease) => Promise<boolean>;
  currentKillSwitchGeneration: (lease: AutomationLease) => Promise<number>;
  isActionHashCurrent: (step: AutomationStep, lease: AutomationLease) => Promise<boolean>;
  browser?: Browser;
}): Promise<ReadonlyArray<AutomationEvent>> {
  if (input.steps.length > browserWorkerConfig.maxSteps)
    throw new Error('automation step limit exceeded');
  const browser = input.browser ?? (await chromium.launch({ headless: true }));
  const ownsBrowser = input.browser === undefined;
  const context = await browser.newContext({ acceptDownloads: false });
  const guard = createBrowserOriginGuard();
  let page: Page | undefined;
  const shutdown = async () => {
    await page?.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    if (ownsBrowser) await browser.close().catch(() => undefined);
  };
  input.signal.addEventListener('abort', () => void shutdown(), { once: true });
  try {
    await context.route('**/*', async (route) => {
      if (await guard.isAllowed(route.request().url(), input.policy)) await route.continue();
      else await route.abort('blockedbyclient');
    });
    const activePage = await context.newPage();
    page = activePage;
    const runner = createBrowserActionRunner({
      page: {
        goto: async (url) => (await activePage.goto(url))?.url() ?? url,
        click: (selector) => activePage.click(selector),
        fill: (selector, value) => activePage.fill(selector, value),
        textContent: (selector) => activePage.textContent(selector),
        screenshot: async () => new Uint8Array(await activePage.screenshot()),
      },
      isSignedLeaseValid: input.isSignedLeaseValid,
      isLeaseCurrent: input.isLeaseCurrent,
      currentKillSwitchGeneration: input.currentKillSwitchGeneration,
      isActionHashCurrent: input.isActionHashCurrent,
      isAllowedUrl: (url, policy) => guard.isAllowed(url, policy),
    });
    return await runner.run(input);
  } finally {
    await shutdown();
  }
}

void browserWorkerConfig;
