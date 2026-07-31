function permissionValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

type OpenOpcServices = Array<{ name: 'AI service' | 'Payment service'; operations: string[] }>;

function openOpcServices(value: unknown): OpenOpcServices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const services = (value as Record<string, unknown>).services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return [];
  return (
    [
      ['ai', 'AI service'],
      ['payment', 'Payment service'],
    ] as const
  ).flatMap(([key, name]) => {
    const declaration = (services as Record<string, unknown>)[key];
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return [];
    const operations = (declaration as Record<string, unknown>).operations;
    if (
      !Array.isArray(operations) ||
      !operations.every((operation) => typeof operation === 'string')
    ) {
      return [];
    }
    return [{ name, operations }];
  });
}

function visibleOpenOpc(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sdkApiVersion = record.sdkApiVersion;
  const services = openOpcServices(value);
  if (sdkApiVersion !== 'v1' && services.length === 0) return undefined;
  return {
    ...(sdkApiVersion === 'v1' ? { sdkApiVersion } : {}),
    ...(services.length > 0
      ? {
          services: Object.fromEntries(
            services.map(({ name, operations }) => [
              name === 'AI service' ? 'ai' : 'payment',
              { operations },
            ]),
          ),
        }
      : {}),
  };
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
  const openopc = visibleOpenOpc(manifest.openopc);
  const services = openOpcServices(manifest.openopc);
  const visibleManifest = {
    ...manifest,
    ...(openopc ? { openopc } : { openopc: undefined }),
  };

  return (
    <section aria-label="Module manifest" className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase text-muted-foreground">Module ID</p>
        <p className="mt-1 break-all text-sm font-medium">{id}</p>
      </div>
      {openopc?.sdkApiVersion ? (
        <div>
          <h3 className="text-sm font-semibold">SDK API version</h3>
          <p className="mt-1 text-sm">{String(openopc.sdkApiVersion)}</p>
        </div>
      ) : null}
      {services.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold">Platform services</h3>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {services.map((service) => (
              <div key={service.name} className="rounded-lg border p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {service.name}
                </p>
                <p className="mt-1 break-words text-sm">{service.operations.join(', ')}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
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
          {JSON.stringify(visibleManifest, null, 2)}
        </pre>
      </details>
    </section>
  );
}
