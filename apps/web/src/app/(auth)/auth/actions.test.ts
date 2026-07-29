import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const otpCalls: unknown[] = [];
const passwordSignupCalls: unknown[] = [];
const passwordSigninCalls: unknown[] = [];

mock.module('@/lib/auth/account-access', () => ({
  accountHasAppAccess: async () => true,
}));
mock.module('@/lib/auth/bootstrap-first-project', () => ({
  resolveFirstProjectPathForNewUser: async () => null,
}));
mock.module('@/lib/auth/mobile-handoff', () => ({
  buildMobileSessionHandoffUrl: () => null,
}));
mock.module('@/lib/auth/return-url', () => ({
  isInviteReturnUrl: () => false,
  sanitizeAuthReturnUrl: (value?: string) => value || '/projects',
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({
    APP_URL: 'https://staging.openopc.example',
    BACKEND_URL: 'https://api.staging.openopc.example/v1',
    BILLING_ENABLED: false,
  }),
}));
mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async (input: unknown) => {
        otpCalls.push(input);
        return { error: null };
      },
      signUp: async (input: unknown) => {
        passwordSignupCalls.push(input);
        return { error: null };
      },
      signInWithPassword: async (input: unknown) => {
        passwordSigninCalls.push(input);
        return { data: { session: null }, error: { message: 'email_not_confirmed' } };
      },
    },
  }),
}));
mock.module('@kortix/sdk/projects-client', () => ({
  fetchAccountStateWithToken: async () => null,
}));
mock.module('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

const originalFetch = globalThis.fetch;
let fetchResponse: Response;
let requests: Array<{ url: string; init?: RequestInit }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  requests.push({ url: String(input), init });
  return fetchResponse.clone();
}) as typeof fetch;

const { signUp, signUpWithPassword } = await import('./actions');

function signupForm(): FormData {
  const form = new FormData();
  form.set('email', 'person@example.com');
  form.set('origin', 'https://staging.openopc.example');
  form.set('returnUrl', '/projects');
  form.set('acceptedTerms', 'true');
  form.set('challengeToken', 'turnstile-response-token');
  form.set('deviceId', 'browser-device-01');
  form.set('policyTermsVersion', '2026-07-28');
  form.set('policyPrivacyVersion', '2026-07-28');
  form.set('policyAcceptableUseVersion', '2026-07-28');
  return form;
}

beforeEach(() => {
  otpCalls.length = 0;
  passwordSignupCalls.length = 0;
  passwordSigninCalls.length = 0;
  requests = [];
  fetchResponse = new Response(null, { status: 503 });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('public registration server actions', () => {
  test('fails closed without calling magic-link OTP when registration authority is unavailable', async () => {
    const result = await signUp(null, signupForm());

    expect(result).toEqual({
      message: 'Registration is temporarily unavailable. Please try again.',
    });
    expect(otpCalls).toHaveLength(0);
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.staging.openopc.example/v1/access/registration/preflight',
    ]);
  });

  test('fails closed on malformed authority success responses', async () => {
    fetchResponse = Response.json({ allowed: true }, { status: 200 });

    expect(await signUp(null, signupForm())).toEqual({
      message: 'Registration is temporarily unavailable. Please try again.',
    });
    expect(otpCalls).toHaveLength(0);
  });

  test('passes one authoritative token and exact policies to Supabase metadata', async () => {
    fetchResponse = Response.json({
      allowed: true,
      decisionToken: 'signed-registration-decision',
      expiresAt: '2026-07-28T12:05:00.000Z',
    });

    const result = await signUp(null, signupForm());

    expect(result).toEqual({
      success: true,
      message: 'Check your email for a magic link to complete sign up',
      email: 'person@example.com',
    });
    expect(otpCalls).toHaveLength(1);
    expect(otpCalls[0]).toEqual({
      email: 'person@example.com',
      options: {
        emailRedirectTo:
          'https://staging.openopc.example/auth/callback?returnUrl=%2Fprojects&email=person%40example.com&terms_accepted=true',
        shouldCreateUser: true,
        data: {
          registration_decision_token: 'signed-registration-decision',
          registration_policy_versions: {
            terms: '2026-07-28',
            privacy: '2026-07-28',
            acceptableUse: '2026-07-28',
          },
        },
      },
    });
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body).toEqual({
      email: 'person@example.com',
      challengeToken: 'turnstile-response-token',
      deviceId: 'browser-device-01',
      action: 'signup',
      policyVersions: {
        terms: '2026-07-28',
        privacy: '2026-07-28',
        acceptableUse: '2026-07-28',
      },
    });
  });

  test('does not let password signup bypass an unavailable registration authority', async () => {
    const form = signupForm();
    form.set('password', 'correct-horse-battery-staple');
    form.set('confirmPassword', 'correct-horse-battery-staple');

    expect(await signUpWithPassword(null, form)).toEqual({
      message: 'Registration is temporarily unavailable. Please try again.',
    });
    expect(passwordSignupCalls).toHaveLength(0);
    expect(passwordSigninCalls).toHaveLength(0);
  });
});
