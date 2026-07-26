import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const ANDROID_HOME =
  process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(process.env.LOCALAPPDATA || '', 'Android/Sdk');

export const ADB_BIN = resolve(ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
export const ADB_DEVICE_SERIAL = process.env.ADB_DEVICE_SERIAL || 'emulator-5554';

export const adb = (args: string[], options: Parameters<typeof execFileSync>[2] = {}) =>
  execFileSync(ADB_BIN, ['-s', ADB_DEVICE_SERIAL, ...args], options);

export const adbOutput = (args: string[]): string => adb(args, { encoding: 'utf-8', stdio: 'pipe' }) as string;

export const runAdbCleanup = (args: string[], description: string): void => {
  try {
    adb(args, { stdio: 'pipe' });
  } catch (err) {
    console.warn(`[android] Cleanup skipped (${description}): ${(err as Error)?.message ?? err}`);
  }
};
