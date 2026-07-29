import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'OpenOPC — Product deck',
  description:
    'A complete, in-depth walkthrough of the OpenOPC platform — the Autonomous Company Operating System.',
  robots: { index: false, follow: false },
};

export default function PlatformPresentationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
