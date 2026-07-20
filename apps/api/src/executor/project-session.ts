/** Only project PATs carry an Executor project-session identity. */
export function projectExecutionSessionId(authType: unknown, sessionId: unknown): string | null {
  return authType === 'pat' && typeof sessionId === 'string' ? sessionId : null;
}
