import { PRODUCT_BRAND } from '@kortix/product-brand';

type ChatIdentitySuccessInput = {
  service: string;
  workspaceName?: string | null;
  resumed: boolean;
  hasAccess: boolean;
};

export function buildAuthWelcomeTitle(): string {
  return `Welcome to ${PRODUCT_BRAND.displayName}`;
}

export function buildChatIdentityConnectCopy(service: string): {
  title: string;
  description: string;
} {
  return {
    title: `Connect ${service} to ${PRODUCT_BRAND.displayName}`,
    description: `The ${PRODUCT_BRAND.displayName} bot in ${service} will run as you, with your own credentials, secrets, and connected apps instead of the installer's.`,
  };
}

export function buildChatIdentitySuccessDescription({
  service,
  workspaceName,
  resumed,
  hasAccess,
}: ChatIdentitySuccessInput): string {
  const workspace = workspaceName ? ` in ${workspaceName}` : '';
  if (!hasAccess) {
    return `Your ${PRODUCT_BRAND.displayName} account is connected${workspace}. Head back to ${service} and request project access to continue.`;
  }
  if (resumed) {
    return `Your ${PRODUCT_BRAND.displayName} account is connected${workspace}. ${PRODUCT_BRAND.displayName} is picking up your ${service} message now.`;
  }
  return `Your ${PRODUCT_BRAND.displayName} account is connected${workspace}. Head back to ${service} and mention ${PRODUCT_BRAND.displayName} with a task.`;
}

export function buildChatIdentityMissingLinkMessage(service: 'Slack' | 'Teams'): string {
  return service === 'Slack'
    ? `This page is opened from an ${PRODUCT_BRAND.displayName} message in Slack. Run /kortix login in Slack to get a fresh link.`
    : `This page is opened from an ${PRODUCT_BRAND.displayName} message in Teams. Start the login from Teams to get a fresh link.`;
}

export function buildNativeBounceBrandCopy(): {
  documentTitle: string;
  openingStatus: string;
  openAction: string;
} {
  return {
    documentTitle: `Opening ${PRODUCT_BRAND.desktopName}…`,
    openingStatus: `Opening ${PRODUCT_BRAND.desktopName}…`,
    openAction: `Open ${PRODUCT_BRAND.desktopName}`,
  };
}
