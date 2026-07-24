import { PublisherReleaseDetailPage } from '@/features/developer-center/publisher/release-detail-page';

export default async function Page({ params }: { params: Promise<{ releaseId: string }> }) {
  const { releaseId } = await params;
  return <PublisherReleaseDetailPage releaseId={releaseId} />;
}
