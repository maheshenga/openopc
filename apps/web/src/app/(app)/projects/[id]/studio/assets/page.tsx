'use client';

import { useParams } from 'next/navigation';

import { StudioShell } from '@/features/studio/studio-shell';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';

export default function ProjectAssetsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <ProjectShell projectId={projectId}>
      <StudioShell projectId={projectId}>
        <div className="min-h-0 flex-1" data-studio-route="assets" />
      </StudioShell>
    </ProjectShell>
  );
}
