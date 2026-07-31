'use client';

import {
  UpgradePlansModal,
  type UpgradePlansModalProps,
} from '@/features/billing/global-upgrade-modal';
import { useRuntimeProfileDisplayState } from './release-profile';

export type TeamPlanCheckoutProps = UpgradePlansModalProps;

export function TeamPlanCheckout(props: TeamPlanCheckoutProps) {
  const runtimeProfile = useRuntimeProfileDisplayState();
  if (runtimeProfile !== 'allowed') return null;
  return <UpgradePlansModal {...props} />;
}
