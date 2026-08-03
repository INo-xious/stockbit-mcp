/**
 * Deleting a browser profile directory we just finished using.
 *
 * This needs its own helper because a plain `rmSync(recursive)` reliably fails here on Windows. The
 * browser process has only just been killed, and Windows keeps the file handles it held open for a
 * short while afterwards — a delete issued immediately gets EPERM/EBUSY. `rmSync`'s own
 * `maxRetries`/`retryDelay` do not cover this case dependably, because the handles belong to a
 * process that is exiting rather than to a transient lock.
 *
 * It matters that this actually succeeds: the directory is a browser profile that was logged into
 * Stockbit, so it contains session cookies and a Login Data store — a second copy of the credential
 * this project exists to protect. Leaving it in %TEMP% is a real leak, not just clutter.
 */
import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Remove a directory, retrying while Windows releases handles.
 *
 * Returns true on success. Never throws: a failure to clean up must not turn a successful login
 * into an error, but the caller is told so it can surface the leak instead of hiding it.
 */
export async function removeDirWithRetry(
  dir: string,
  { attempts = 12, delayMs = 250 }: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      if (i === attempts - 1) return false;
      await delay(delayMs);
    }
  }
  return false;
}
