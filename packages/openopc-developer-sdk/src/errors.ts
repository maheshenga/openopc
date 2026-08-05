export type OpenOpcModuleRequestErrorCode =
  | 'OPENOPC_MODULE_REQUEST_ABORTED'
  | 'OPENOPC_MODULE_REQUEST_TIMEOUT'
  | 'OPENOPC_MODULE_REQUEST_FAILED';

const DEFAULT_MESSAGES: Record<OpenOpcModuleRequestErrorCode, string> = {
  OPENOPC_MODULE_REQUEST_ABORTED: 'OpenOPC module service request was aborted',
  OPENOPC_MODULE_REQUEST_TIMEOUT: 'OpenOPC module service request timed out',
  OPENOPC_MODULE_REQUEST_FAILED: 'OpenOPC module service request failed',
};

/** A stable, provider-neutral error for transport lifecycle failures. */
export class OpenOpcModuleRequestError extends Error {
  constructor(
    readonly code: OpenOpcModuleRequestErrorCode,
    message = DEFAULT_MESSAGES[code],
  ) {
    super(message);
    this.name = 'OpenOpcModuleRequestError';
  }
}
