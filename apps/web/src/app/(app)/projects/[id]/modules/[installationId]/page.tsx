import { ProjectModuleHostPage } from '@/features/project-modules/project-module-host-page';

export default async function ProjectModuleHostRoute({
  params,
}: {
  params: Promise<{ id: string; installationId: string }>;
}) {
  const { id, installationId } = await params;
  return <ProjectModuleHostPage projectId={id} installationId={installationId} />;
}
