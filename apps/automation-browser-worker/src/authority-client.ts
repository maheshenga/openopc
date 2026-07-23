import {
  AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
  type AutomationBrowserAuthorityCheckAccepted,
  AutomationBrowserAuthorityCheckAcceptedSchema,
  type AutomationBrowserAuthorityCheckInput,
  AutomationBrowserAuthorityCheckInputSchema,
} from '@kortix/intelligence-contracts';
import {
  type WorkerControlClient,
  WorkerControlClientError,
  type WorkerControlResponse,
} from './worker-control-client';

export type BrowserAuthorityInput = Omit<AutomationBrowserAuthorityCheckInput, 'requested_at'>;

export class BrowserAuthorityClientError extends Error {
  override readonly name = 'BrowserAuthorityClientError';

  constructor(
    readonly reason: 'configuration' | 'transport' | 'protocol' | 'rejected',
    message: string,
    readonly response?: Readonly<{ status: number; code: string; retryable: boolean }>,
  ) {
    super(message);
  }
}

export type BrowserAuthorityClient = Readonly<{
  check(input: BrowserAuthorityInput): Promise<AutomationBrowserAuthorityCheckAccepted>;
}>;

function mapClientError(error: unknown): BrowserAuthorityClientError {
  if (error instanceof BrowserAuthorityClientError) return error;
  if (error instanceof WorkerControlClientError) {
    return new BrowserAuthorityClientError(
      error.reason,
      error.reason === 'rejected'
        ? 'Browser authority check was rejected'
        : 'Browser authority check failed',
      error.response,
    );
  }
  return new BrowserAuthorityClientError('transport', 'Browser authority check failed');
}

function bindAuthorityResponse(
  response: WorkerControlResponse<AutomationBrowserAuthorityCheckAccepted>,
  request: AutomationBrowserAuthorityCheckInput,
): AutomationBrowserAuthorityCheckAccepted {
  if (!response.ok) {
    throw new BrowserAuthorityClientError('rejected', 'Browser authority check was rejected', {
      status: response.status,
      code: response.body.code,
      retryable: response.body.retryable,
    });
  }
  const accepted = AutomationBrowserAuthorityCheckAcceptedSchema.safeParse(response.body);
  if (
    !accepted.success ||
    accepted.data.job_id !== request.job_id ||
    accepted.data.lease_id !== request.lease_id ||
    accepted.data.check !== request.check.kind ||
    accepted.data.kill_switch_generation !== request.kill_switch_generation
  ) {
    throw new BrowserAuthorityClientError(
      'protocol',
      'Browser authority check response is invalid',
    );
  }
  return accepted.data;
}

export function createBrowserAuthorityClient(input: {
  client: WorkerControlClient;
  now?: () => Date;
}): BrowserAuthorityClient {
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async check(authority: BrowserAuthorityInput) {
      let request: AutomationBrowserAuthorityCheckInput;
      try {
        const requestedAt = now();
        if (!Number.isFinite(requestedAt.getTime())) {
          throw new Error('invalid authority clock');
        }
        request = AutomationBrowserAuthorityCheckInputSchema.parse({
          ...authority,
          requested_at: requestedAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof BrowserAuthorityClientError) throw error;
        throw new BrowserAuthorityClientError(
          'configuration',
          'Browser authority check input is invalid',
        );
      }
      try {
        const response = await input.client.request({
          path: AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
          bodyKey: 'authority',
          body: request,
          schema: AutomationBrowserAuthorityCheckAcceptedSchema,
        });
        return bindAuthorityResponse(response, request);
      } catch (error) {
        throw mapClientError(error);
      }
    },
  });
}
