export interface ElectronSmokeLaunchInput {
  executablePath: string;
  desktopRoot: string;
  appMode?: 'unpacked' | 'packaged';
  appDataDir: string;
  baseUrl: string;
  baseEnv: NodeJS.ProcessEnv;
}

export interface ElectronSmokeLaunchOptions {
  executablePath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  headless: false;
  timeout: number;
}

function portablePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/$/, '');
}

export function createElectronSmokeLaunchOptions({
  executablePath,
  desktopRoot,
  appMode = 'unpacked',
  appDataDir,
  baseUrl,
  baseEnv,
}: ElectronSmokeLaunchInput): ElectronSmokeLaunchOptions {
  const normalizedRoot = portablePath(desktopRoot);
  const normalizedAppData = portablePath(appDataDir);
  const bootstrapUrl = `${baseUrl.replace(/\/$/, '')}/robots.txt`;

  return {
    executablePath,
    args: appMode === 'packaged' ? [] : [`--app=${normalizedRoot}`],
    env: {
      ...baseEnv,
      APPDATA: normalizedAppData,
      HOME: normalizedAppData,
      XDG_CONFIG_HOME: normalizedAppData,
      KORTIX_DESKTOP_URL: bootstrapUrl,
      KORTIX_DESKTOP_DEFAULT_URL: bootstrapUrl,
    },
    headless: false,
    timeout: 60_000,
  };
}
