export interface AdminApiError {
  message: string;
  status?: number;
}

export interface AdminApiResponse<T = any> {
  data?: T;
  error?: AdminApiError;
  success: boolean;
}

export interface AdminApiClientOptions {
  showErrors?: boolean;
  timeout?: number;
  adminReason?: string;
}

export function resolveAdminApiBase(env: Record<string, string | undefined>): string {
  const candidate = env.OPENOPC_ADMIN_API_URL?.trim() || env.KORTIX_API_URL?.trim();
  if (!candidate) throw new Error('OPENOPC_ADMIN_API_URL or KORTIX_API_URL is required');
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Admin API URL must use HTTP or HTTPS');
  }
  return candidate.replace(/\/+$/, '');
}

async function request<T>(
  method: string,
  endpoint: string,
  body?: unknown,
  options?: RequestInit & AdminApiClientOptions,
): Promise<AdminApiResponse<T>> {
  const {
    showErrors: _showErrors,
    timeout,
    adminReason,
    headers,
    signal: callerSignal,
    ...requestOptions
  } = options ?? {};
  const normalizedAdminReason = adminReason?.trim();
  if (adminReason !== undefined && (!normalizedAdminReason || normalizedAdminReason.length > 500)) {
    return {
      success: false,
      error: { message: 'Admin reason must contain 1 to 500 characters', status: 400 },
    };
  }
  const path = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutHandle =
    timeout && timeout > 0 ? setTimeout(() => controller.abort('Admin API timeout'), timeout) : null;

  try {
    const response = await fetch(`/api/admin-proxy/${path}`, {
      ...requestOptions,
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(normalizedAdminReason
          ? { 'x-openopc-admin-reason': normalizedAdminReason }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? typeof (payload as { error: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : JSON.stringify((payload as { error: unknown }).error)
          : `Admin API request failed with status ${response.status}`;
      return { success: false, error: { message, status: response.status } };
    }
    return { success: true, data: payload as T };
  } catch (error) {
    return {
      success: false,
      error: { message: error instanceof Error ? error.message : 'Admin API request failed' },
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export const backendApi = {
  get: <T = any>(endpoint: string, options?: RequestInit & AdminApiClientOptions) =>
    request<T>('GET', endpoint, undefined, options),
  post: <T = any>(endpoint: string, body?: unknown, options?: RequestInit & AdminApiClientOptions) =>
    request<T>('POST', endpoint, body, options),
  put: <T = any>(endpoint: string, body?: unknown, options?: RequestInit & AdminApiClientOptions) =>
    request<T>('PUT', endpoint, body, options),
  patch: <T = any>(endpoint: string, body?: unknown, options?: RequestInit & AdminApiClientOptions) =>
    request<T>('PATCH', endpoint, body, options),
  delete: <T = any>(endpoint: string, options?: RequestInit & AdminApiClientOptions) =>
    request<T>('DELETE', endpoint, undefined, options),
};
