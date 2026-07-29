import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';

import { resolveDesktopSession } from './session';

export async function GET() {
  try {
    const supabase = await createClient();
    const identity = await resolveDesktopSession(() => supabase.auth.getUser());
    return NextResponse.json(identity, {
      status: 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: 'Unauthenticated' },
      {
        status: 401,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  }
}
