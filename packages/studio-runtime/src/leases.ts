export function studioMaintenanceLeaseName(scope?: string): string {
  if (!scope) {
    return 'studio-maintenance';
  }
  return `studio-maintenance:${scope}`;
}
