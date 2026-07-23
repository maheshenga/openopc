import {
  AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
  AutomationBrowserApprovalConsumeAcceptedSchema,
  type AutomationBrowserApprovalConsumeInput,
  AutomationBrowserApprovalConsumeInputSchema,
} from '@kortix/intelligence-contracts';
import {
  type WorkerControlClient,
  WorkerControlClientError,
  type WorkerControlTransport,
  createWorkerControlClient,
  createWorkerControlMtlsTransport,
} from './worker-control-client';

export type BrowserApprovalResumeTransport = WorkerControlTransport;

export type BrowserApprovalResumeClient = Readonly<{
  consume(input: AutomationBrowserApprovalConsumeInput): Promise<
    Readonly<{
      consumed: true;
      idempotent: boolean;
      approvalId: string;
      attemptId: string;
      jobId: string;
      stepId: string;
      startedAt: string;
    }>
  >;
}>;

export class BrowserApprovalResumeClientError extends Error {
  override readonly name = 'BrowserApprovalResumeClientError';

  constructor(
    readonly reason: 'configuration' | 'transport' | 'protocol' | 'rejected',
    message: string,
    readonly response?: Readonly<{ status: number; code: string; retryable: boolean }>,
  ) {
    super(message);
  }
}

function mapWorkerControlError(error: unknown): BrowserApprovalResumeClientError {
  if (error instanceof BrowserApprovalResumeClientError) return error;
  if (error instanceof WorkerControlClientError) {
    const messages = {
      configuration: 'Browser approval resume client configuration is invalid',
      transport: 'Browser approval resume transport failed',
      protocol: 'Browser approval resume response is invalid',
      rejected: 'Browser approval resume was rejected',
    } as const;
    return new BrowserApprovalResumeClientError(
      error.reason,
      messages[error.reason],
      error.response,
    );
  }
  return new BrowserApprovalResumeClientError(
    'transport',
    'Browser approval resume transport failed',
  );
}

export function createBrowserApprovalResumeClient(input: {
  controlUrl: string;
  serviceId: string;
  certificateFingerprint256: string;
  sharedSecret: string;
  requestTimeoutMs: number;
  transport: BrowserApprovalResumeTransport;
  nextNonce: () => number;
  now?: () => Date;
}): BrowserApprovalResumeClient {
  let client: WorkerControlClient;
  try {
    client = createWorkerControlClient(input);
  } catch (error) {
    throw mapWorkerControlError(error);
  }

  return Object.freeze({
    async consume(rawInput) {
      const consume = AutomationBrowserApprovalConsumeInputSchema.parse(rawInput);
      try {
        const response = await client.request({
          path: AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
          bodyKey: 'consume',
          body: consume,
          schema: AutomationBrowserApprovalConsumeAcceptedSchema,
        });
        if (!response.ok) {
          const error = response.body;
          throw new BrowserApprovalResumeClientError(
            'rejected',
            'Browser approval resume was rejected',
            { status: response.status, code: error.code, retryable: error.retryable },
          );
        }
        const accepted = AutomationBrowserApprovalConsumeAcceptedSchema.safeParse(response.body);
        if (
          !accepted.success ||
          accepted.data.approval_id !== consume.approval_id ||
          accepted.data.attempt_id !== consume.attempt_id ||
          accepted.data.job_id !== consume.job_id ||
          accepted.data.step_id !== consume.step_id
        ) {
          throw new BrowserApprovalResumeClientError(
            'protocol',
            'Browser approval resume response is invalid',
          );
        }
        return {
          consumed: true,
          idempotent: accepted.data.idempotent,
          approvalId: accepted.data.approval_id,
          attemptId: accepted.data.attempt_id,
          jobId: accepted.data.job_id,
          stepId: accepted.data.step_id,
          startedAt: accepted.data.started_at,
        };
      } catch (error) {
        throw mapWorkerControlError(error);
      }
    },
  });
}

export function createBrowserApprovalResumeMtlsTransport(input: {
  controlUrl: string;
  mtlsCertificatePath: string;
  mtlsPrivateKeyPath: string;
  mtlsCaPath: string;
  baseFetch?: BrowserApprovalResumeTransport;
}): BrowserApprovalResumeTransport {
  try {
    return createWorkerControlMtlsTransport(input);
  } catch (error) {
    throw mapWorkerControlError(error);
  }
}
