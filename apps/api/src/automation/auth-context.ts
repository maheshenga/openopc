import { z } from 'zod';
import type { AutomationControlActor } from './control-client';

const UuidSchema = z.string().uuid();

export type AutomationLoadedProject = Readonly<{
  row: { projectId: string; accountId: string };
  userId: string;
  accountRole?: string | null;
  projectRole?: string | null;
  effectiveRole?: string | null;
}>;

export function automationActorFromProject(
  project: AutomationLoadedProject,
  deviceId: string | null = null,
): AutomationControlActor {
  const privileged = new Set(['owner', 'admin', 'manager']);
  const roles: AutomationControlActor['roles'][number][] = privileged.has(
    project.effectiveRole ?? '',
  )
    ? ['project_admin']
    : ['member'];
  if (project.accountRole === 'owner' || project.accountRole === 'admin') {
    roles.push('security_admin');
  }
  return {
    accountId: UuidSchema.parse(project.row.accountId),
    projectId: UuidSchema.parse(project.row.projectId),
    userId: UuidSchema.parse(project.userId),
    roles,
    deviceId: deviceId && UuidSchema.safeParse(deviceId).success ? deviceId : null,
  };
}
