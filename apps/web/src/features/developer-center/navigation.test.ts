import { describe, expect, test } from 'bun:test';

const userMenuSource = await Bun.file('src/features/layout/user-menu.tsx').text();

describe('Developer Center navigation and localization', () => {
  test('exposes the publisher route from consumer navigation', () => {
    expect(userMenuSource).toContain("router.push('/developer/modules')");
  });

  test('ships the typed developerCenter namespace in every web locale', async () => {
    for (const locale of ['en', 'zh', 'de', 'es', 'fr', 'it', 'ja', 'pt']) {
      const messages = JSON.parse(await Bun.file(`translations/${locale}.json`).text());
      expect(messages.developerCenter.publisher.recentReleases).toBeString();
      expect(messages.developerCenter.admin.moduleReviews).toBeString();
      expect(messages.developerCenter.errors.DEVELOPER_REVIEW_CONFLICT).toBeString();
    }
  });
});
