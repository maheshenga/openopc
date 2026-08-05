import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

let selectedAccountId = 'account-a';
let publisherAccess: unknown;
let publisherAccessError = false;
let publisherAccessLoading = false;

beforeEach(() => {
  selectedAccountId = 'account-a';
  publisherAccess = undefined;
  publisherAccessError = false;
  publisherAccessLoading = false;
});

mock.module('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined }),
}));

mock.module('@/lib/use-permission', () => ({
  usePermission: () => ({ allowed: true }),
}));

mock.module('@/stores/current-account-store', () => ({
  useCurrentAccountStore: <T,>(selector: (state: { selectedAccountId: string }) => T) =>
    selector({ selectedAccountId }),
}));

mock.module('./access-query', () => ({
  useDeveloperPublisherAccess: () => ({
    data: publisherAccess,
    isError: publisherAccessError,
    isLoading: publisherAccessLoading,
    refetch: () => undefined,
  }),
}));

mock.module('./publisher-select', () => ({
  DeveloperPublisherSelect: ({
    id,
    publishers,
    value,
    onValueChange,
  }: {
    id: string;
    publishers: Array<{ publisher: { publisher_id: string; display_name: string } }>;
    value: string;
    onValueChange: (publisherId: string) => void;
  }) => (
    <select id={id} value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      <option value="">Select a Publisher</option>
      {publishers.map((entry) => (
        <option key={entry.publisher.publisher_id} value={entry.publisher.publisher_id}>
          {entry.publisher.display_name}
        </option>
      ))}
    </select>
  ),
}));

const { PublisherModuleSubmitPage } = await import('./submit-page');

function publisher(publisherId: string, accountId: string) {
  return {
    publisher: {
      publisher_id: publisherId,
      account_id: accountId,
      display_name: publisherId,
      status: 'active',
    },
    membership: { role: 'owner' },
  };
}

function access(
  accountId: string,
  publisherIds: string[],
  packageUpload: boolean | undefined,
) {
  return {
    account_id: accountId,
    user_id: 'user-1',
    organization: null,
    invitations: [],
    publishers: publisherIds.map((publisherId) => publisher(publisherId, accountId)),
    ...(packageUpload === undefined
      ? {}
      : { capabilities: { package_upload: packageUpload } }),
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    HTMLElement?: typeof HTMLElement;
    HTMLSelectElement?: typeof HTMLSelectElement;
    Event?: typeof Event;
  };
  globals.window = dom.window as never;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.HTMLSelectElement = dom.window.HTMLSelectElement;
  globals.Event = dom.window.Event;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

describe('PublisherModuleSubmitPage package Publisher selection', () => {
  test('shows package upload only for matching explicit true access', async () => {
    const dom = installDom();
    const container = document.getElementById('root');
    if (!container) throw new Error('test root missing');
    const root = createRoot(container);
    const render = async () => {
      await act(async () => {
        root.render(<PublisherModuleSubmitPage />);
      });
    };
    const packageTab = () =>
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Package upload',
      );
    const expectDeclarativeOnly = (state: string) => {
      expect({ state, packageTab: packageTab()?.textContent }).toEqual({
        state,
        packageTab: undefined,
      });
      expect(document.querySelector('[aria-label="Module manifest input"]')).not.toBeNull();
    };

    try {
      publisherAccess = access('account-a', ['a1'], true);
      publisherAccessLoading = true;
      await render();
      expectDeclarativeOnly('loading');

      publisherAccessLoading = false;
      publisherAccessError = true;
      await render();
      expectDeclarativeOnly('error-with-stale-data');

      publisherAccessError = false;
      publisherAccess = access('account-b', ['b1'], true);
      await render();
      expectDeclarativeOnly('account-mismatch');

      publisherAccess = access('account-a', ['a1'], undefined);
      await render();
      expectDeclarativeOnly('missing-capability');

      publisherAccess = access('account-a', ['a1'], false);
      await render();
      expectDeclarativeOnly('explicit-false');

      publisherAccess = access('account-a', ['a1'], true);
      await render();
      expect(packageTab()).toBeDefined();
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });

  test('clears an idle package Publisher selection when capability is lost', async () => {
    const dom = installDom();
    const container = document.getElementById('root');
    if (!container) throw new Error('test root missing');
    const root = createRoot(container);
    const render = async () => {
      await act(async () => {
        root.render(<PublisherModuleSubmitPage />);
      });
    };
    const packageTab = () =>
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Package upload',
      );
    const publisherSelect = () => {
      const element = document.getElementById('developer-module-publisher');
      if (!(element instanceof HTMLSelectElement)) throw new Error('Publisher select missing');
      return element;
    };

    try {
      publisherAccess = access('account-a', ['a1', 'a2'], true);
      await render();

      await act(async () => {
        packageTab()?.dispatchEvent(new Event('click', { bubbles: true }));
      });
      await act(async () => {
        const select = publisherSelect();
        select.value = 'a2';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(publisherSelect().value).toBe('a2');

      publisherAccess = access('account-a', ['a1', 'a2'], false);
      await render();
      expect(packageTab()).toBeUndefined();
      expect(document.querySelector('[aria-label="Package upload"]')).toBeNull();
      expect(document.querySelector('[aria-label="Module manifest input"]')).not.toBeNull();

      publisherAccess = access('account-a', ['a1', 'a2'], true);
      await render();
      await act(async () => {
        packageTab()?.dispatchEvent(new Event('click', { bubbles: true }));
      });
      expect(publisherSelect().value).toBe('');
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });

  test('clears an old multi-Publisher choice after switching A to B and back to A', async () => {
    const dom = installDom();
    const container = document.getElementById('root');
    if (!container) throw new Error('test root missing');
    const root = createRoot(container);
    const render = async () => {
      await act(async () => {
        root.render(<PublisherModuleSubmitPage />);
      });
    };
    const publisherSelect = () => {
      const element = document.getElementById('developer-module-publisher');
      if (!(element instanceof HTMLSelectElement)) throw new Error('Publisher select missing');
      return element;
    };

    try {
      selectedAccountId = 'account-a';
      publisherAccess = access('account-a', ['a1', 'a2'], true);
      await render();

      await act(async () => {
        const packageTab = [...document.querySelectorAll('button')].find(
          (button) => button.textContent === 'Package upload',
        );
        packageTab?.dispatchEvent(new Event('click', { bubbles: true }));
      });
      expect(publisherSelect().value).toBe('');

      await act(async () => {
        const select = publisherSelect();
        select.value = 'a2';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(publisherSelect().value).toBe('a2');

      selectedAccountId = 'account-b';
      publisherAccess = access('account-b', ['b1', 'b2'], true);
      await render();
      expect(publisherSelect().value).toBe('');

      selectedAccountId = 'account-a';
      publisherAccess = access('account-a', ['a1', 'a2'], true);
      await render();
      expect(publisherSelect().value).toBe('');
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
});
