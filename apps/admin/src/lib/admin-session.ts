export interface AdminSession {
  userId: string;
  permissions: string[];
  stepUpExpiresAt: string | null;
}

export const ADMIN_SESSION_COOKIE = 'openopc_admin_session';
export const ADMIN_STEP_UP_COOKIE = 'openopc_admin_step_up';

const FORWARDABLE_ADMIN_COOKIES = new Set([ADMIN_SESSION_COOKIE, ADMIN_STEP_UP_COOKIE]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function forwardableAdminCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader || CONTROL_CHARACTER.test(cookieHeader)) return null;
  const selected: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const candidate = part.trim();
    const separator = candidate.indexOf('=');
    if (separator <= 0) continue;
    const name = candidate.slice(0, separator).trim();
    const value = candidate.slice(separator + 1).trim();
    if (!FORWARDABLE_ADMIN_COOKIES.has(name) || !value || CONTROL_CHARACTER.test(value)) continue;
    selected.push(`${name}=${value}`);
  }
  return selected.length > 0 ? selected.join('; ') : null;
}
