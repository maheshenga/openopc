'use client';

import { Image as ImageIcon, Images } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { AssetsPage } from '@/features/studio/assets-page';
import { ImageStudioPage } from '@/features/studio/image-studio-page';
import { StudioShell } from '@/features/studio/studio-shell';
import { setBootstrapAuthToken } from '@/lib/auth-token';

const DEBUG_PROJECT_ID = '12000000-0000-4000-a000-000000000001';

export default function DebugImageStudioPage() {
  const t = useTranslations('studio');
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<'image' | 'assets'>('image');

  useEffect(() => {
    setBootstrapAuthToken('debug-image-studio-token');
    setReady(true);
    return () => setBootstrapAuthToken(null);
  }, []);

  if (!ready) return null;

  return (
    <main className="bg-background text-foreground flex h-svh min-h-0 flex-col overflow-hidden">
      <header className="border-border flex h-11 shrink-0 items-center justify-end gap-1 border-b px-3">
        <Button
          type="button"
          size="sm"
          variant={view === 'image' ? 'secondary' : 'ghost'}
          className="h-10 transition-transform active:scale-[0.96]"
          aria-pressed={view === 'image'}
          data-testid="debug-studio-image"
          onClick={() => setView('image')}
        >
          <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
          {t('imageStudio')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={view === 'assets' ? 'secondary' : 'ghost'}
          className="h-10 transition-transform active:scale-[0.96]"
          aria-pressed={view === 'assets'}
          data-testid="debug-studio-assets"
          onClick={() => setView('assets')}
        >
          <Images className="size-4 shrink-0" aria-hidden="true" />
          {t('assets')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <StudioShell projectId={DEBUG_PROJECT_ID}>
          {view === 'image' ? (
            <ImageStudioPage projectId={DEBUG_PROJECT_ID} />
          ) : (
            <AssetsPage projectId={DEBUG_PROJECT_ID} />
          )}
        </StudioShell>
      </div>
    </main>
  );
}
