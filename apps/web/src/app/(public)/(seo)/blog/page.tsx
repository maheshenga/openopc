import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';

import { PostCard } from '@/components/blog/post-card';
import { Reveal } from '@/components/home/reveal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { getAllPosts } from '@/lib/blog';
import { siteMetadata } from '@/lib/site-metadata';
import { PRODUCT_BRAND } from '@kortix/product-brand';

const TITLE = 'Blog';
const DESCRIPTION =
  `Field notes on building, running, and governing AI agents that do real work — from the team building the ${PRODUCT_BRAND.displayName} command center.`;
const URL = `${siteMetadata.url}/blog`;
const SOCIAL_IMAGE = `${siteMetadata.url}/brandkit/Profile%20Picture/Avatar%20Black.png`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    `${PRODUCT_BRAND.displayName} blog`,
    'AI agents',
    'AI command center',
    'AI workforce',
    'agent automation',
  ],
  openGraph: {
    type: 'website',
    title: `${PRODUCT_BRAND.displayName} ${TITLE}`,
    description: DESCRIPTION,
    url: URL,
    siteName: PRODUCT_BRAND.displayName,
    images: [{ url: SOCIAL_IMAGE }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${PRODUCT_BRAND.displayName} ${TITLE}`,
    description: DESCRIPTION,
    images: [SOCIAL_IMAGE],
  },
  alternates: {
    canonical: URL,
    types: { 'application/rss+xml': `${URL}/rss.xml` },
  },
};

export default function BlogIndexPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const posts = getAllPosts();
  const [featured, ...rest] = posts;

  // Blog + ItemList structured data so search engines understand the listing.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `${PRODUCT_BRAND.displayName} Blog`,
    description: DESCRIPTION,
    url: URL,
    publisher: {
      '@type': 'Organization',
      name: PRODUCT_BRAND.displayName,
      logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.png` },
    },
    blogPost: posts.map((post) => ({
      '@type': 'BlogPosting',
      headline: post.data.title,
      description: post.data.description,
      datePublished: post.data.date,
      author: { '@type': 'Person', name: post.author.name },
      url: `${siteMetadata.url}${post.url}`,
    })),
  };

  return (
    <main className="bg-background min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="mx-auto max-w-5xl px-6 pt-24 pb-24 sm:pt-32 sm:pb-32">
        <Reveal>
          <h1 className="text-foreground mb-3 text-3xl font-medium tracking-tight sm:text-4xl md:text-5xl">
            {TITLE}
          </h1>
          <p className="text-muted-foreground max-w-xl text-base leading-relaxed">{DESCRIPTION}</p>
        </Reveal>

        {posts.length === 0 ? (
          <div className="mt-16">
            <EmptyState
              title={tI18nHardcoded.raw('autoAppPublicSeoBlogPageJsxAttrTitleNoPosts340caa81')}
              description={tI18nHardcoded.raw(
                'autoAppPublicSeoBlogPageJsxAttrDescriptionWeRecebec139',
              )}
            />
          </div>
        ) : (
          <div className="mt-12 sm:mt-16">
            <Reveal>
              <PostCard post={featured} featured />
            </Reveal>

            {rest.length > 0 && (
              <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
                {rest.map((post, i) => (
                  <Reveal key={post.slug} delay={Math.min(i * 0.05, 0.2)}>
                    <PostCard post={post} />
                  </Reveal>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
