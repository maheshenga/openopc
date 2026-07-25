import type { DeveloperModuleReleaseStatus } from '@kortix/sdk';
import type { ComponentProps } from 'react';

import { Badge } from '@/components/ui/badge';

const STATUS_LABELS: Record<DeveloperModuleReleaseStatus, string> = {
  draft: 'Draft',
  uploaded: 'Uploaded',
  validated: 'Validated',
  verifying: 'Verifying',
  review_pending: 'Review pending',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  signed: 'Signed',
  published: 'Published',
  revoked: 'Revoked',
  deprecated: 'Deprecated',
};

const STATUS_VARIANTS: Record<
  DeveloperModuleReleaseStatus,
  ComponentProps<typeof Badge>['variant']
> = {
  draft: 'muted',
  uploaded: 'info',
  validated: 'info',
  verifying: 'warning',
  review_pending: 'warning',
  changes_requested: 'warning',
  approved: 'success',
  signed: 'success',
  published: 'success',
  revoked: 'destructive',
  deprecated: 'muted',
};

export function DeveloperModuleStatusBadge({
  status,
}: {
  status: DeveloperModuleReleaseStatus;
}) {
  return (
    <Badge variant={STATUS_VARIANTS[status]} aria-label={`Status: ${STATUS_LABELS[status]}`}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
