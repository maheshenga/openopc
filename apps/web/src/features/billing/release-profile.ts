'use client';

import { useEffect, useState } from 'react';

export type RuntimeProfileDisplayState = 'loading' | 'restricted' | 'allowed';

export function parseRuntimeProfileDisplayState(value: unknown): RuntimeProfileDisplayState {
  if (!value || typeof value !== 'object') return 'restricted';
  const record = value as { ready?: unknown; release_profile_id?: unknown };
  if (record.ready !== true || typeof record.release_profile_id !== 'string') return 'restricted';
  return 'restricted';
}

export function useRuntimeProfileDisplayState(): RuntimeProfileDisplayState {
  const [state, setState] = useState<RuntimeProfileDisplayState>('loading');
  useEffect(() => {
    let current = true;
    void fetch('/v1/runtime-profile')
      .then(async (response) =>
        response.ok ? parseRuntimeProfileDisplayState(await response.json()) : 'restricted',
      )
      .catch((): RuntimeProfileDisplayState => 'restricted')
      .then((next) => current && setState(next));
    return () => {
      current = false;
    };
  }, []);
  return state;
}
