import { AUTOMATION_MAX_STEPS } from '@kortix/intelligence-contracts';

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

export const browserWorkerConfig = Object.freeze({
  port: positiveInteger('AUTOMATION_BROWSER_PORT', 8091),
  maxSteps: AUTOMATION_MAX_STEPS,
  maxRuntimeMs: positiveInteger('AUTOMATION_BROWSER_MAX_RUNTIME_MS', 120_000),
  maxDownloads: positiveInteger('AUTOMATION_BROWSER_MAX_DOWNLOADS', 4),
  maxDownloadBytes: positiveInteger('AUTOMATION_BROWSER_MAX_DOWNLOAD_BYTES', 25 * 1024 * 1024),
  maxMemoryMb: positiveInteger('AUTOMATION_BROWSER_MAX_MEMORY_MB', 512),
  maxCpuSeconds: positiveInteger('AUTOMATION_BROWSER_MAX_CPU_SECONDS', 120),
});
