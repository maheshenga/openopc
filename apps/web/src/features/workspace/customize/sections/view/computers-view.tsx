'use client';

import { LocalAccessPanel } from '@/features/desktop/local-access-panel';
import { useAuth } from '@/features/providers/auth-provider';
import { TunnelOverview } from '@/features/tunnel/tunnel-overview';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

export function ComputersView({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE).allowed === true;
  return (
    <div className="space-y-4">
      <TunnelOverview canWrite={canWrite} />
      <LocalAccessPanel userId={user?.id ?? ''} />
    </div>
  );
}
