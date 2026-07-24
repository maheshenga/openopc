import { useTranslations } from 'next-intl';

export const DEVELOPER_CENTER_ERROR_CODES = [
  'DEVELOPER_REQUEST_FAILED',
  'DEVELOPER_MODULE_INVALID',
  'DEVELOPER_PUBLISHER_MISMATCH',
  'DEVELOPER_PUBLISHER_CONFLICT',
  'DEVELOPER_MODULE_VERSION_CONFLICT',
  'DEVELOPER_RELEASE_NOT_FOUND',
  'DEVELOPER_REVIEW_REASON_REQUIRED',
  'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE',
  'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED',
  'DEVELOPER_REVIEW_TRANSITION_INVALID',
  'DEVELOPER_REVIEW_CONFLICT',
] as const;

export type DeveloperCenterErrorCode = (typeof DEVELOPER_CENTER_ERROR_CODES)[number];
export type DeveloperCenterErrorMessageKey = `errors.${DeveloperCenterErrorCode}`;

export interface DeveloperCenterLabels {
  publisher: {
    title: string;
    recentReleases: string;
    submitNewVersion: string;
    requestReview: string;
    resubmit: string;
  };
  admin: {
    moduleReviews: string;
    reviewQueue: string;
    requestChanges: string;
    approve: string;
    revoke: string;
  };
  error: (code: DeveloperCenterErrorCode) => string;
}

/** Typed adapter for the isolated Developer Center translation namespace. */
export function useDeveloperCenterLabels(): DeveloperCenterLabels {
  const t = useTranslations('developerCenter');

  return {
    publisher: {
      title: t('publisher.title'),
      recentReleases: t('publisher.recentReleases'),
      submitNewVersion: t('publisher.submitNewVersion'),
      requestReview: t('publisher.requestReview'),
      resubmit: t('publisher.resubmit'),
    },
    admin: {
      moduleReviews: t('admin.moduleReviews'),
      reviewQueue: t('admin.reviewQueue'),
      requestChanges: t('admin.requestChanges'),
      approve: t('admin.approve'),
      revoke: t('admin.revoke'),
    },
    error: (code) => t(`errors.${code}` as DeveloperCenterErrorMessageKey),
  };
}
