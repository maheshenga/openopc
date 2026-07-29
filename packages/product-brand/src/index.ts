export const PRODUCT_BRAND = {
  displayName: 'OpenOPC',
  desktopName: 'OpenOPC Desktop',
  localNodeName: 'OpenOPC Local Execution',
} as const;

export function openOpcEnv(
  name: string,
  legacyName: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[name] || env[legacyName] || undefined;
}
