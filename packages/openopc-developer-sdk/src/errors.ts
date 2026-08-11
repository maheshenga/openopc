export type OpenOpcModuleRequestErrorCode =
  | 'OPENOPC_MODULE_REQUEST_ABORTED'
  | 'OPENOPC_MODULE_REQUEST_TIMEOUT'
  | 'OPENOPC_MODULE_REQUEST_FAILED'
  | 'OPENOPC_MODULE_CAPABILITY_RATE_LIMITED';

const DEFAULT_MESSAGES: Record<OpenOpcModuleRequestErrorCode, string> = {
  OPENOPC_MODULE_REQUEST_ABORTED: 'OpenOPC module service request was aborted',
  OPENOPC_MODULE_REQUEST_TIMEOUT: 'OpenOPC module service request timed out',
  OPENOPC_MODULE_REQUEST_FAILED: 'OpenOPC module service request failed',
  OPENOPC_MODULE_CAPABILITY_RATE_LIMITED:
    'OpenOPC module capability requests are temporarily rate limited',
};

/** A stable, provider-neutral error for transport lifecycle failures. */
export class OpenOpcModuleRequestError extends Error {
  constructor(
    readonly code: OpenOpcModuleRequestErrorCode,
    message = DEFAULT_MESSAGES[code],
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'OpenOpcModuleRequestError';
  }
}
