import { getServerPublicEnv } from '@/lib/public-env-server';
import { PRODUCT_BRAND } from '@kortix/product-brand';
import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;

  const title = `Shared Conversation | ${PRODUCT_BRAND.displayName}`;
  const description = `Replay this Worker conversation on ${PRODUCT_BRAND.displayName}`;
  const url = getServerPublicEnv().APP_URL || 'https://kortix.com';
  const socialImage = `${url}/brandkit/Profile%20Picture/Avatar%20Black.png`;

  return {
    title,
    description,
    alternates: {
      canonical: `${url}/share/${shareId}`,
    },
    openGraph: {
      title,
      description,
      images: [socialImage],
    },
    twitter: {
      title,
      description,
      images: socialImage,
      card: 'summary_large_image',
    },
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
