import type { Metadata } from 'next';
import { KortixParticleMark } from './kortix-particle-mark';

export const metadata: Metadata = {
  title: 'Particle Mark — OpenOPC',
  description: 'A Rauch-style hard-pixel particle rendering of the OpenOPC symbol.',
  robots: { index: false, follow: false },
};

export default function RauchPage() {
  return (
    <main className="fixed inset-0 overflow-hidden bg-background">
      <KortixParticleMark />
    </main>
  );
}
