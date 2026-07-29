import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES = ['de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'zh'] as const;

const TECHNICAL_COMPATIBILITY_KEYS = [
  'hardcodedUi.appCliAuthorizePage.line214JsxTextAuthorizeKortixCli',
  'hardcodedUi.componentsProjectsProjectCreateModal.line362JsxAttrTitleConnectTheKortixGithubApp',
  'hardcodedUi.componentsSettingsUserSettingsModal.line1725JsxTextLedgerBackedAccountEventsFromTheKortixSchema',
  'hardcodedUi.autoAppPublicMarketingDevelopersPageJsxTextKortixExecutor80880ab2',
  'hardcodedUi.autoComponentsProjectsCustomizeSectionsDevViewJsxAttrTitleInstall5ee6d4a5',
  'hardcodedUi.autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintWiresd2c58a2a',
  'hardcodedUi.autoComponentsProjectsCustomizeSectionsDevViewJsxAttrHintThisb45ed869',
  'hardcodedUi.autoFeaturesLayoutDownloadAppsModalJsxAttrDescriptionBuildRun4761ab6f',
] as const;

const TECHNICAL_COMPATIBILITY_KEY_SET = new Set<string>(TECHNICAL_COMPATIBILITY_KEYS);
const EXECUTOR_KEY =
  'hardcodedUi.autoAppPublicMarketingDevelopersPageJsxTextKortixExecutor80880ab2';
const BUILD_RUN_KEY =
  'hardcodedUi.autoFeaturesLayoutDownloadAppsModalJsxAttrDescriptionBuildRun4761ab6f';

function stringEntries(value: unknown, path: string[] = []): Array<[string[], string]> {
  if (typeof value === 'string') return [[path, value]];
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, child]) => stringEntries(child, [...path, key]));
}

function isVisibleBrandScope(path: string[]): boolean {
  const joined = path.join('.');
  return (
    !joined.startsWith('hardcodedUi.appLegalPage.') &&
    !TECHNICAL_COMPATIBILITY_KEY_SET.has(joined)
  );
}

function stringAtPath(value: unknown, path: string): string | undefined {
  let current = value;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function withoutCompatibilityNames(value: string): string {
  return value
    .replaceAll('KortixDesktop', '')
    .replaceAll('Kortix CLI', '')
    .replaceAll('Kortix-CLI', '')
    .replaceAll('Kortix SDK', '')
    .replaceAll('Kortix REST API', '')
    .replaceAll('Kortix API', '')
    .replaceAll('Kortix GitHub App', '')
    .replaceAll('Kortix Executor', '')
    .replaceAll('Kortix Master', '')
    .replaceAll('Kortix schema', '')
    .replaceAll('Kortix skill', '')
    .replaceAll('Kortix as a Backend', '')
    .replaceAll('new Kortix()', '')
    .replaceAll('Kortix.createKortix', '')
    .replaceAll('Kortix AI, Inc.', '')
    .replaceAll('Kortix AI Corp', '')
    .replaceAll('Kortix Public Source License', '')
    .replaceAll('X-Kortix-Signature', '');
}

test('translated product surfaces present OpenOPC while retaining legal and technical compatibility names', () => {
  const offenders: string[] = [];

  for (const locale of LOCALES) {
    const messages = JSON.parse(
      readFileSync(resolve(process.cwd(), 'translations', `${locale}.json`), 'utf8'),
    ) as Record<string, unknown>;

    for (const [path, value] of stringEntries(messages)) {
      if (!isVisibleBrandScope(path)) continue;
      if (/\b(?:Kortix|Cortix)\b/.test(withoutCompatibilityNames(value))) {
        offenders.push(`${locale}:${path.join('.')}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});

test('translated technical surfaces retain their formal Kortix compatibility names', () => {
  const offenders: string[] = [];

  for (const locale of LOCALES) {
    const messages = JSON.parse(
      readFileSync(resolve(process.cwd(), 'translations', `${locale}.json`), 'utf8'),
    ) as Record<string, unknown>;

    for (const key of TECHNICAL_COMPATIBILITY_KEYS) {
      const value = stringAtPath(messages, key);
      const marker = locale === 'zh' && key === EXECUTOR_KEY ? '科尔蒂克斯' : 'Kortix';
      if (!value?.includes(marker)) offenders.push(`${locale}:${key}`);
      if (key === BUILD_RUN_KEY && !value?.includes('OpenOPC')) {
        offenders.push(`${locale}:${key}:product-name`);
      }
    }
  }

  expect(offenders).toEqual([]);
});

test('public compatibility docs retain the shipped protocol header names', () => {
  const triggers = readFileSync(
    resolve(process.cwd(), 'content', 'docs', 'reference', 'triggers.mdx'),
    'utf8',
  );
  const sessionRuntime = readFileSync(
    resolve(process.cwd(), 'content', 'docs', 'reference', 'session-runtime.mdx'),
    'utf8',
  );

  expect(triggers.match(/X-Kortix-Token/g)).toHaveLength(1);
  expect(sessionRuntime.match(/X-Kortix-User-Context/g)).toHaveLength(2);
  expect(triggers).not.toContain('X-OpenOPC-Token');
  expect(sessionRuntime).not.toContain('X-OpenOPC-User-Context');
});

test('Web setup surfaces retain the shipped Kortix skill name', () => {
  const cliDemo = readFileSync(
    resolve(process.cwd(), 'src', 'components', 'home', 'cli-demo.tsx'),
    'utf8',
  );
  const projectCreateModal = readFileSync(
    resolve(
      process.cwd(),
      'src',
      'features',
      'projects',
      'modal',
      'project-create-modal.tsx',
    ),
    'utf8',
  );

  expect(cliDemo).toContain('It picks up the Kortix skill');
  expect(projectCreateModal).toContain('full Kortix skill kit —');
});
