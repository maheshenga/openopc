import { AdminDeveloperApplicationDetailPage } from '@/features/developer-center/applications/application-detail-page';

export default async function Page({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const { applicationId } = await params;
  return <AdminDeveloperApplicationDetailPage applicationId={applicationId} />;
}
