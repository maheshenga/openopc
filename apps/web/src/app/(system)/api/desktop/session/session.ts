const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DesktopSessionErrorCode = 'UNAUTHENTICATED' | 'INVALID_IDENTITY';

export class DesktopSessionError extends Error {
  readonly code: DesktopSessionErrorCode;

  constructor(code: DesktopSessionErrorCode, message: string) {
    super(message);
    this.name = 'DesktopSessionError';
    this.code = code;
  }
}

function sessionError(code: 'UNAUTHENTICATED' | 'INVALID_IDENTITY', message: string) {
  return new DesktopSessionError(code, message);
}

export async function resolveDesktopSession(
  getUser: () => Promise<{ data?: { user?: { id?: unknown } | null }; error?: unknown }>,
): Promise<{ userId: string }> {
  let result;
  try {
    result = await getUser();
  } catch {
    throw sessionError('UNAUTHENTICATED', 'The desktop session is not authenticated');
  }
  if (result.error || !result.data?.user) {
    throw sessionError('UNAUTHENTICATED', 'The desktop session is not authenticated');
  }
  const userId = result.data.user.id;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw sessionError('INVALID_IDENTITY', 'The desktop session identity is invalid');
  }
  return { userId };
}
