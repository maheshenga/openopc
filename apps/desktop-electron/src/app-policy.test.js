const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  downloadFromWebContents,
  isLocalGrantOperation,
  isTrustedAppSender,
  normalizeDownloadUrl,
  shouldLoadInApp,
  shouldRegisterProtocol,
} = require('./app-policy');

const desktopRoot = path.join(__dirname, '..');
const repoRoot = path.join(desktopRoot, '..', '..');

function readDesktopFile(relativePath) {
  return readFileSync(path.join(desktopRoot, relativePath), 'utf8');
}

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function topLevelYamlScalar(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

function loadProductBrandForPackage(productName) {
  const module = { exports: {} };
  vm.runInNewContext(readDesktopFile(path.join('src', 'product-brand.js')), {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '../package.json') return { productName };
      throw new Error(`Unexpected product-brand dependency: ${specifier}`);
    },
  });
  return module.exports;
}

describe('desktop visible brand and compatibility identity', () => {
  test('uses OpenOPC settings first and exposes a clear local execution label', () => {
    const { PRODUCT_BRAND, openOpcEnv } = require('./product-brand');

    expect(PRODUCT_BRAND).toEqual({
      displayName: 'OpenOPC',
      desktopName: 'OpenOPC Desktop',
      localNodeName: 'OpenOPC Local Execution',
    });
    expect(
      openOpcEnv('OPENOPC_DESKTOP_URL', 'KORTIX_DESKTOP_URL', {
        OPENOPC_DESKTOP_URL: 'https://app.openopc.example/projects',
        KORTIX_DESKTOP_URL: 'https://kortix.example/projects',
      }),
    ).toBe('https://app.openopc.example/projects');
    expect(
      openOpcEnv('OPENOPC_DESKTOP_URL', 'KORTIX_DESKTOP_URL', {
        KORTIX_DESKTOP_URL: 'https://kortix.example/projects',
      }),
    ).toBe('https://kortix.example/projects');
  });

  test('packages installers and shortcuts under the OpenOPC product name', () => {
    const packageJson = JSON.parse(readDesktopFile('package.json'));
    const builder = readDesktopFile('electron-builder.yml');

    expect(packageJson.productName).toBe('OpenOPC');
    expect(packageJson.description).toContain('OpenOPC');
    expect(packageJson.author).toBe('Kortix AI Corp');
    expect(topLevelYamlScalar(builder, 'productName')).toBe('OpenOPC');
    expect(topLevelYamlScalar(builder, 'copyright')).toBe('© Kortix AI Corp');
    expect(builder).toContain('title: OpenOPC ${version}');
    expect(builder).toContain('artifactName: ${productName}-Setup-${version}.${ext}');
  });

  test('shows OpenOPC while the native shell starts', () => {
    expect(readDesktopFile(path.join('assets', 'splash.html'))).toContain('<title>OpenOPC</title>');
  });

  test('keeps stable desktop identifiers used by installed apps and OAuth callbacks', () => {
    const packageJson = JSON.parse(readDesktopFile('package.json'));
    const builder = readDesktopFile('electron-builder.yml');

    expect(packageJson.name).toBe('@kortix/desktop-electron');
    expect(topLevelYamlScalar(builder, 'appId')).toBe('com.kortix.desktop');
    expect(builder).toMatch(
      /protocols:\s*[\s\S]*- name: Kortix\s*[\s\S]*schemes:\s*[\s\S]*- kortix/,
    );
  });

  test('keeps legacy user data isolated between production and development channels', () => {
    const { legacyUserDataName } = require('./product-brand');

    expect(legacyUserDataName('OpenOPC')).toBe('Kortix Desktop');
    expect(legacyUserDataName('OpenOPC Dev')).toBe('Kortix Dev Desktop');
    expect(legacyUserDataName('OpenOPC Canary')).toBe('Kortix Canary Desktop');
  });

  test('keeps a packaged development build on the legacy development data directory', () => {
    const { legacyUserDataName } = loadProductBrandForPackage('OpenOPC Dev');

    expect(legacyUserDataName('OpenOPC Dev')).toBe('Kortix Dev Desktop');
  });

  test('keeps release workflows on the OpenOPC visible brand', () => {
    const desktopWorkflow = readRepoFile(path.join('.github', 'workflows', 'desktop.yml'));
    const productionWorkflow = readRepoFile(path.join('.github', 'workflows', 'deploy-prod.yml'));

    expect(desktopWorkflow).toContain('--config.productName="OpenOPC Dev"');
    expect(desktopWorkflow).toContain('--config.extraMetadata.productName="OpenOPC Dev"');
    expect(desktopWorkflow).not.toContain('productName="Kortix Dev"');
    expect(productionWorkflow).toContain('--arg header "🚀 OpenOPC ${TAG} is live (EKS)"');
  });
});

describe('desktop protocol registration policy', () => {
  test('skips registration only for an explicit e2e smoke run', () => {
    expect(typeof shouldRegisterProtocol).toBe('function');
    expect(shouldRegisterProtocol({})).toBe(true);
    expect(shouldRegisterProtocol({ KORTIX_E2E_DISABLE_PROTOCOL_REGISTRATION: '0' })).toBe(true);
    expect(shouldRegisterProtocol({ KORTIX_E2E_DISABLE_PROTOCOL_REGISTRATION: '1' })).toBe(false);
  });
});

describe('desktop local-grant IPC policy', () => {
  test('allows only the three bounded local-grant operations', () => {
    expect(isLocalGrantOperation('requestLocalGrant')).toBe(true);
    expect(isLocalGrantOperation('listLocalGrants')).toBe(true);
    expect(isLocalGrantOperation('revokeLocalGrant')).toBe(true);
    expect(isLocalGrantOperation('readFile')).toBe(false);
    expect(isLocalGrantOperation('execute')).toBe(false);
  });

  test('trusts only the exact configured app origin for privileged IPC', () => {
    expect(
      isTrustedAppSender('https://kortix.com/projects', 'https://kortix.com/projects/project-1'),
    ).toBe(true);
    expect(
      isTrustedAppSender(
        'https://app.openopc.example/projects',
        'https://app.openopc.example/accounts/settings',
      ),
    ).toBe(true);
    expect(
      isTrustedAppSender(
        'https://kortix.com/projects',
        'https://attacker.kortix.com/projects/project-1',
      ),
    ).toBe(false);
    expect(
      isTrustedAppSender(
        'https://app.openopc.example/projects',
        'https://app.openopc.example/pricing',
      ),
    ).toBe(false);
  });

  test('passes the resolved grant roots into the native approval dialog', () => {
    const mainSource = readDesktopFile(path.join('src', 'main.js'));

    expect(mainSource).toContain(
      "confirm: (resolvedCommand) => localGrantDialog(resolvedCommand, 'request')",
    );
    expect(mainSource).not.toContain("confirm: () => localGrantDialog(command, 'request')");
  });
});

describe('desktop app navigation policy', () => {
  test('keeps project Image Studio routes inside the OpenOPC window', () => {
    expect(shouldLoadInApp('https://kortix.com/projects/project-1/studio/image')).toBe(true);
    expect(
      shouldLoadInApp('https://dev.kortix.com/projects/project-1/studio/image?task=task-1'),
    ).toBe(true);
    expect(shouldLoadInApp('http://localhost:3000/projects/project-1/studio/image')).toBe(true);
  });

  test('keeps marketing and provider OAuth navigations outside the app window', () => {
    expect(shouldLoadInApp('https://kortix.com/pricing')).toBe(false);
    expect(shouldLoadInApp('https://supa.kortix.com/auth/v1/authorize?provider=github')).toBe(
      false,
    );
  });

  test('keeps exact-origin self-hosted product routes inside the configured desktop app', () => {
    const configured = 'https://app.openopc.example/projects';

    expect(shouldLoadInApp('https://app.openopc.example/projects/project-1', configured)).toBe(
      true,
    );
    expect(shouldLoadInApp('https://attacker.openopc.example/projects/project-1', configured)).toBe(
      false,
    );
    expect(shouldLoadInApp('https://app.openopc.example/pricing', configured)).toBe(false);
  });

  test('keeps every authenticated top-level Web workflow inside the desktop app', () => {
    const configured = 'https://app.openopc.example/projects';
    const workflowPaths = ['/developer/modules', '/review', '/legacy-machines'];

    for (const workflowPath of workflowPaths) {
      const workflowUrl = `https://app.openopc.example${workflowPath}`;
      expect(shouldLoadInApp(workflowUrl, configured)).toBe(true);
      expect(isTrustedAppSender(configured, workflowUrl)).toBe(true);
    }
  });
});

describe('desktop native download policy', () => {
  test('allows HTTPS and loopback HTTP asset URLs', () => {
    expect(
      normalizeDownloadUrl('https://assets.example.test/object.png?signature=short-lived'),
    ).toBe('https://assets.example.test/object.png?signature=short-lived');
    expect(normalizeDownloadUrl('http://localhost:54321/storage/object.png')).toBe(
      'http://localhost:54321/storage/object.png',
    );
    expect(normalizeDownloadUrl('http://127.0.0.1:54321/storage/object.png')).toBe(
      'http://127.0.0.1:54321/storage/object.png',
    );
    expect(normalizeDownloadUrl('http://[::1]:54321/storage/object.png')).toBe(
      'http://[::1]:54321/storage/object.png',
    );
  });

  test('rejects credentials, remote HTTP, dangerous schemes, and malformed URLs', () => {
    const rejected = [
      'https://user:secret@assets.example.test/object.png',
      'http://assets.example.test/object.png',
      'file:///tmp/private.txt',
      'data:text/plain,private',
      'javascript:alert(1)',
      'not a URL',
    ];

    for (const url of rejected) {
      expect(normalizeDownloadUrl(url)).toBeNull();
    }
  });

  test('starts valid downloads on the requesting WebContents only', () => {
    const downloads = [];
    const webContents = { downloadURL: (url) => downloads.push(url) };
    const signedUrl = 'https://assets.example.test/object.png?signature=short-lived';

    downloadFromWebContents(webContents, signedUrl);

    expect(downloads).toEqual([signedUrl]);
    expect(() => downloadFromWebContents(webContents, 'file:///tmp/private.txt')).toThrow(
      'Invalid download URL',
    );
    expect(downloads).toEqual([signedUrl]);
  });
});
