import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { PRODUCT_BRAND } from '@kortix/product-brand';

import messages from '../../translations/en.json';

import { AdminShell } from './_components/admin-shell';
import { AdminProviders } from './providers';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-session';

import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${PRODUCT_BRAND.displayName} Admin`,
  description: `${PRODUCT_BRAND.displayName} platform operations console`,
  applicationName: `${PRODUCT_BRAND.displayName} Admin`,
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const rawSidebarState = cookieStore.get('sidebar_state')?.value;
  const initialSidebarOpen =
    rawSidebarState === 'true' ? true : rawSidebarState === 'false' ? false : true;

  // Task 4 uses session presence only to decide whether client queries may run.
  // API authorization remains authoritative; Task 5 replaces this compatibility
  // boundary with the fully verified AdminSession.
  const sessionPresent = Boolean(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-svh bg-background text-foreground antialiased">
        <NextIntlClientProvider locale="en" messages={messages}>
          <AdminProviders sessionPresent={sessionPresent}>
            <AdminShell initialOpen={initialSidebarOpen}>{children}</AdminShell>
          </AdminProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
