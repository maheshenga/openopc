import { ProjectModulesPage } from '@/features/project-modules/project-modules-page';

export default async function ProjectModulesRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectModulesPage projectId={id} />;
}
