'use client';

import { useParams } from 'next/navigation';

import { ImageStudioPage } from '@/features/studio/image-studio-page';
import { StudioShell } from '@/features/studio/studio-shell';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';

export default function ProjectImageStudioPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <ProjectShell projectId={projectId}>
      <StudioShell projectId={projectId}>
        <ImageStudioPage projectId={projectId} />
      </StudioShell>
    </ProjectShell>
  );
}
