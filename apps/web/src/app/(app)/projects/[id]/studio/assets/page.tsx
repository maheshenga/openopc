'use client';

import { useParams } from 'next/navigation';

import { AssetsPage } from '@/features/studio/assets-page';
import { StudioShell } from '@/features/studio/studio-shell';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';

export default function ProjectAssetsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <ProjectShell projectId={projectId}>
      <StudioShell projectId={projectId}>
        <AssetsPage projectId={projectId} />
      </StudioShell>
    </ProjectShell>
  );
}
