import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';

import { MobileImageStudioPage } from '@/components/studio/MobileImageStudioPage';

export default function ProjectImageStudioRoute() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = Array.isArray(id) ? id[0] : id;

  if (!projectId) return null;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <MobileImageStudioPage
        projectId={projectId}
        onBack={() => router.replace(`/projects/${projectId}`)}
      />
    </>
  );
}
