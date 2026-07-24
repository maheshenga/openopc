import type { DeveloperModuleReviewRequirement } from '@kortix/sdk';

const REQUIREMENT_LABELS: Record<DeveloperModuleReviewRequirement, string> = {
  manifest_review: 'Manifest review',
  source_scan: 'Source scan',
  sandbox_test: 'Sandbox test',
  permission_review: 'Permission review',
  desktop_security_review: 'Desktop security review',
  human_review: 'Human review',
};

export function DeveloperModuleRequirements({
  requirements,
}: {
  requirements: readonly DeveloperModuleReviewRequirement[];
}) {
  return (
    <section aria-label="Review requirements" className="space-y-2">
      <h3 className="text-sm font-semibold">Review requirements</h3>
      {requirements.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {requirements.map((requirement) => (
            <li key={requirement} className="rounded-lg border px-3 py-2 text-sm">
              {REQUIREMENT_LABELS[requirement]}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No review requirements declared.</p>
      )}
    </section>
  );
}
