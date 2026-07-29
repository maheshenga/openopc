import { PRODUCT_BRAND } from '@kortix/product-brand';

export function getIncludedCreditsDescription(): string {
  return `Included with your ${PRODUCT_BRAND.displayName} credits`;
}

export function getModelSetupDescription(): string {
  return `Log in with your coding subscription, paste an API key, or skip to use ${PRODUCT_BRAND.displayName} credits.`;
}

export function getManagedKeysOverrideDescription(): string {
  return `These keys will override the default ${PRODUCT_BRAND.displayName}-managed keys for these tools.`;
}

export function getCreditsLabel(): string {
  return `${PRODUCT_BRAND.displayName} Credits`;
}

export function getBootCpuLabel(): string {
  return `CPU: ${PRODUCT_BRAND.displayName} Inference Engine X1 @ 3.80 GHz`;
}

export function getBootBiosLabel(): string {
  return `${PRODUCT_BRAND.displayName.toUpperCase()} BIOS v2.0.1`;
}

export function getBootOsLabel(): string {
  return `All systems nominal. Starting ${PRODUCT_BRAND.displayName.toUpperCase()} OS...`;
}

export function getModelConnectionDescription(): string {
  return `This session needs an LLM connected before it can respond. Upgrade for instant access to ${PRODUCT_BRAND.displayName}'s managed models, or bring your own API key from any provider.`;
}

export function getModelAvailabilityMessage(): string {
  return `Connect a model via provider first or upgrade your ${PRODUCT_BRAND.displayName} subscription.`;
}

export function getSessionStartAriaLabel(): string {
  return `Starting your ${PRODUCT_BRAND.localNodeName}`;
}

export function getVersionHistoryDescription(): string {
  return `Version history for ${PRODUCT_BRAND.localNodeName}`;
}

export function getTeamPlanLabel(): string {
  return `${PRODUCT_BRAND.displayName} Team`;
}

export function getSubscriptionActivatedDescription(): string {
  return `Your team is on ${getTeamPlanLabel()}. Compute and LLM credits are ready.`;
}

export function getNewVersionLabel(channel: 'dev' | 'stable'): string {
  return channel === 'dev' ? 'New dev build' : `New ${PRODUCT_BRAND.displayName} version`;
}

export function getMobileAppAlt(): string {
  return `${PRODUCT_BRAND.displayName} mobile app`;
}
