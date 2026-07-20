import { describe, expect, test } from 'bun:test';
import { projectExecutionSessionId } from './project-session';

describe('projectExecutionSessionId', () => {
  test('accepts only a project PAT session and drops an IdP login session', () => {
    expect(projectExecutionSessionId('supabase', 'supabase-login-session')).toBeNull();
    expect(projectExecutionSessionId('service_account', 'service-session')).toBeNull();
    expect(projectExecutionSessionId('pat', 'project-session-123')).toBe('project-session-123');
  });
});
