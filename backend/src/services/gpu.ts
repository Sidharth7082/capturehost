import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GpuSample {
  utilPct: number;
  memUsedMb: number;
  memTotalMb: number;
  tempC: number | null;
}

/** Returns null when there is no usable GPU (or no driver at all). */
export type GpuProbe = () => Promise<GpuSample | null>;

const QUERY_FIELDS = 'utilization.gpu,memory.used,memory.total,temperature.gpu';

export interface GpuProbeOptions {
  /** Binary name or absolute path. Overridable so tests can pass a fake. */
  binary?: string;
  /** How long to stop asking after a failure (missing binary, no driver). */
  unavailableTtlMs?: number;
  timeoutMs?: number;
}

function toNumber(raw: string): number | null {
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses `nvidia-smi --format=csv,noheader,nounits` output: `42, 1024, 4096, 55`.
 * `[N/A]` (common for temperature on some laptop GPUs) becomes null.
 */
export function parseNvidiaSmiLine(line: string): GpuSample | null {
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length < 3) return null;

  const utilPct = toNumber(parts[0] ?? '');
  const memUsedMb = toNumber(parts[1] ?? '');
  const memTotalMb = toNumber(parts[2] ?? '');
  if (utilPct === null || memUsedMb === null || memTotalMb === null) return null;

  return {
    utilPct,
    memUsedMb,
    memTotalMb,
    tempC: parts[3] === undefined ? null : toNumber(parts[3]),
  };
}

/**
 * Builds a GPU probe backed by `nvidia-smi`.
 *
 * - Uses execFile with an argument array: no shell, so no injection surface.
 * - A missing binary (ENOENT) is an expected state on GPU-less machines, not an
 *   error: we return null and stop retrying for `unavailableTtlMs` so the log
 *   does not fill up with noise.
 */
export function createGpuProbe(options: GpuProbeOptions = {}): GpuProbe {
  const binary = options.binary ?? 'nvidia-smi';
  const unavailableTtlMs = options.unavailableTtlMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 1500;

  let disabledUntil = 0;

  return async (): Promise<GpuSample | null> => {
    if (Date.now() < disabledUntil) return null;

    try {
      const { stdout } = await execFileAsync(
        binary,
        [`--query-gpu=${QUERY_FIELDS}`, '--format=csv,noheader,nounits'],
        { timeout: timeoutMs },
      );

      const firstLine = stdout.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
      if (firstLine === undefined) {
        disabledUntil = Date.now() + unavailableTtlMs;
        return null;
      }

      const parsed = parseNvidiaSmiLine(firstLine);
      if (parsed === null) disabledUntil = Date.now() + unavailableTtlMs;
      return parsed;
    } catch {
      // ENOENT / EACCES / non-zero exit / timeout all land here.
      disabledUntil = Date.now() + unavailableTtlMs;
      return null;
    }
  };
}
