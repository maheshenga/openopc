export interface RegistrationCompletionInput {
  backendUrl: string;
  accessToken: string;
  userMetadata: Record<string, unknown> | null | undefined;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export type RegistrationCompletionResult =
  | { required: false; completed: true }
  | { required: true; completed: boolean };

export async function completeRegistrationFromSession(
  input: RegistrationCompletionInput,
): Promise<RegistrationCompletionResult> {
  const decisionToken = input.userMetadata?.registration_decision_token;
  if (typeof decisionToken !== 'string' || decisionToken.length === 0) {
    return { required: false, completed: true };
  }
  if (!input.backendUrl || !input.accessToken) {
    return { required: true, completed: false };
  }

  try {
    const response = await (input.fetchImpl ?? fetch)(
      `${input.backendUrl.replace(/\/+$/, '')}/access/registration/complete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decisionToken }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return { required: true, completed: false };
    const body: unknown = await response.json();
    return {
      required: true,
      completed:
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        (body as { completed?: unknown }).completed === true,
    };
  } catch {
    return { required: true, completed: false };
  }
}

export function registrationMetadataAfterCompletion(
  metadata: Record<string, unknown> | null | undefined,
  completedAt = new Date(),
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    registration_decision_token: null,
    registration_completed_at: completedAt.toISOString(),
  };
}
