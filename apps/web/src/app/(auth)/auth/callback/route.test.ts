import { describe, expect, mock, test } from 'bun:test';

import {
  completeRegistrationFromSession,
  registrationMetadataAfterCompletion,
} from '../complete-registration';

describe('registration callback completion', () => {
  test('does nothing for ordinary login sessions without a registration decision', async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 500 }));
    expect(
      await completeRegistrationFromSession({
        backendUrl: 'https://api.openopc.example/v1',
        accessToken: 'access-token',
        userMetadata: { theme: 'dark' },
        fetchImpl,
      }),
    ).toEqual({ required: false, completed: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('posts only the signed decision with the verified session token', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ completed: true });
    });
    const result = await completeRegistrationFromSession({
      backendUrl: 'https://api.openopc.example/v1/',
      accessToken: 'verified-session-token',
      userMetadata: {
        registration_decision_token: 'signed-decision',
        registration_policy_versions: { terms: 'attacker-controlled' },
      },
      fetchImpl,
    });
    expect(result).toEqual({ required: true, completed: true });
    expect(requests[0]?.url).toBe('https://api.openopc.example/v1/access/registration/complete');
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: 'Bearer verified-session-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      decisionToken: 'signed-decision',
    });
  });

  test('fails closed on dependency errors and malformed success responses', async () => {
    for (const response of [
      new Response(null, { status: 503 }),
      Response.json({ completed: false }),
      Response.json({ ok: true }),
    ]) {
      const result = await completeRegistrationFromSession({
        backendUrl: 'https://api.openopc.example/v1',
        accessToken: 'access-token',
        userMetadata: { registration_decision_token: 'signed-decision' },
        fetchImpl: async () => response,
      });
      expect(result).toEqual({ required: true, completed: false });
    }
  });

  test('clears only the one-time token after durable completion', () => {
    expect(
      registrationMetadataAfterCompletion(
        {
          registration_decision_token: 'signed-decision',
          registration_policy_versions: { terms: '2026-07-28' },
          referral_code: 'TEAM',
        },
        new Date('2026-07-28T12:00:00.000Z'),
      ),
    ).toEqual({
      registration_decision_token: null,
      registration_policy_versions: { terms: '2026-07-28' },
      registration_completed_at: '2026-07-28T12:00:00.000Z',
      referral_code: 'TEAM',
    });
  });
});
