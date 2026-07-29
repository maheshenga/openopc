import { AdminDeveloperReviewDetailPage } from '@/features/developer-center/review-detail-page';

export default async function Page({ params }: { params: Promise<{ releaseId: string }> }) {
  const { releaseId } = await params;
  return <AdminDeveloperReviewDetailPage releaseId={releaseId} />;
}
