import { describe, expect, mock, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

mock.module('next-intl', () => ({
  useTranslations: () => Object.assign(() => '', { raw: () => '' }),
}));

const { default: BlogIndexPage, metadata } = await import('./page');

function blogStructuredData(): Record<string, any> {
  const page = BlogIndexPage() as ReactElement<{ children: ReactNode }>;
  const script = Children.toArray(page.props.children).find(
    (child): child is ReactElement<{ dangerouslySetInnerHTML: { __html: string } }> =>
      isValidElement(child) && child.type === 'script',
  );
  expect(script).toBeDefined();
  return JSON.parse(script!.props.dangerouslySetInnerHTML.__html);
}

describe('blog channel branding', () => {
  test('publishes OpenOPC metadata for the current blog channel', () => {
    expect(metadata.description).toContain('OpenOPC');
    expect(metadata.keywords).toContain('OpenOPC blog');
    expect(metadata.openGraph).toMatchObject({
      title: 'OpenOPC Blog',
      siteName: 'OpenOPC',
      images: [
        {
          url: 'https://kortix.com/brandkit/Profile%20Picture/Avatar%20Black.png',
        },
      ],
    });
    expect(metadata.twitter).toMatchObject({
      title: 'OpenOPC Blog',
      images: ['https://kortix.com/brandkit/Profile%20Picture/Avatar%20Black.png'],
    });
  });

  test('identifies OpenOPC as the blog publisher in JSON-LD', () => {
    expect(blogStructuredData()).toMatchObject({
      '@type': 'Blog',
      name: 'OpenOPC Blog',
      publisher: {
        '@type': 'Organization',
        name: 'OpenOPC',
      },
    });
  });
});
