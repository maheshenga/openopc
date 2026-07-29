'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminAccessRequestsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/?section=access-requests');
  }, [router]);
  return null;
}
