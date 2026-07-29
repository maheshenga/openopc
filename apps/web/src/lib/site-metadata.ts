/**
 * Site metadata configuration - SIMPLE AND WORKING
 */

import { PRODUCT_BRAND } from '@kortix/product-brand';

/**
 * One public origin for canonical URLs, sitemaps, structured data, and
 * machine-readable representations. Runtime app URLs are deliberately not
 * used here: a preview/dev hostname must never become the canonical origin.
 */
export const CANONICAL_ORIGIN = 'https://kortix.com';

export const siteMetadata = {
  name: PRODUCT_BRAND.displayName,
  title: `${PRODUCT_BRAND.displayName} – The AI Command Center for Your Company`,
  description:
    'The open-source AI command center for your company. Every agent, skill, and memory is a file in one versioned repo you own — a workforce of AI agents that does real work, shared across your whole team from Slack, Teams, the web, or the CLI. Self-hostable, any model, your keys.',
  url: CANONICAL_ORIGIN,
  keywords:
    `${PRODUCT_BRAND.displayName}, AI command center, autonomous company operating system, workforce of AI agents, company as a git repo, agents skills and memory as files, shared AI agents, scoped access, open source AI platform, self-hosted AI agents, connect 3000 tools, agent orchestration, AI-native company, AI operations`,
};
