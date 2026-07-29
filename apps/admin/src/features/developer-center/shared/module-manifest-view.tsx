function permissionValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function DeveloperModuleManifestView({
  manifest,
}: {
  manifest: Record<string, unknown>;
}) {
  const id = typeof manifest.id === 'string' ? manifest.id : 'Unknown module';
  const permissions =
    manifest.permissions && typeof manifest.permissions === 'object'
      ? (manifest.permissions as Record<string, unknown>)
      : {};

  return (
    <section aria-label="Module manifest" className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase text-muted-foreground">Module ID</p>
        <p className="mt-1 break-all text-sm font-medium">{id}</p>
      </div>
      <div>
        <h3 className="text-sm font-semibold">Permissions</h3>
        {Object.keys(permissions).length > 0 ? (
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {Object.entries(permissions).map(([scope, values]) => (
              <div key={scope} className="rounded-lg border p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">{scope}</p>
                <p className="mt-1 break-words text-sm">{permissionValue(values)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No permissions declared.</p>
        )}
      </div>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">Raw manifest</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      </details>
    </section>
  );
}
