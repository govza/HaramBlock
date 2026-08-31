import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { config as baseConfig } from './wdio.conf.js';
import { ADB_BIN, ADB_DEVICE_SERIAL, ANDROID_HOME, adb, adbOutput, runAdbCleanup } from '../utils/android.js';
import { getExtensionPath, getGeckoAddonId } from '../utils/extension-path.js';

const ADDON_ID = await getGeckoAddonId();
const FENIX_PACKAGE = 'org.mozilla.fenix';
const FENIX_ARCHIVE_BASE = 'https://archive.mozilla.org/pub/fenix/nightly';
const FENIX_PINNED_BUILD = process.env.FENIX_NIGHTLY_BUILD;
const DEBUG_CI_MODE = process.argv.includes('--debug');
export const IS_CI = Boolean(process.env.CI) || DEBUG_CI_MODE;
const AVD_NAME = process.env.AVD_NAME || 'Pixel_3a_API_34_extension_level_7_x86_64';
const EMULATOR_BIN = resolve(ANDROID_HOME, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
const FENIX_CACHE_DIR = resolve(import.meta.dirname, '../../../node_modules/.cache/firefox-nightly');

const envFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  return !['0', 'false', 'no'].includes(value.toLowerCase());
};

const getPageLoadStrategy = (): 'normal' | 'eager' | 'none' => {
  // Default to 'none' — geckodriver hangs waiting for page-load events on
  // moz-extension:// URLs in Firefox Android, so we skip the wait and rely
  // on explicit element waits in step definitions instead.
  const value = process.env.ANDROID_PAGE_LOAD_STRATEGY || 'none';
  if (value === 'normal' || value === 'eager' || value === 'none') return value;
  throw new Error(`Invalid ANDROID_PAGE_LOAD_STRATEGY "${value}". Use "normal", "eager", or "none".`);
};

const MANAGE_EMULATOR = envFlag(process.env.ANDROID_MANAGE_EMULATOR, !IS_CI);
const SINGLE_SESSION = envFlag(process.env.ANDROID_SINGLE_SESSION, !IS_CI);
const CLEANUP_BETWEEN_SESSIONS = envFlag(process.env.ANDROID_CLEANUP_BETWEEN_SESSIONS, false);
const { ANDROID_E2E_TAGS } = process.env;
const DEVICE_EXT_PATH = '/data/local/tmp/haramblock-extension';
const FENIX_TEST_ROOT = `/storage/emulated/0/Android/data/${FENIX_PACKAGE}/files/test_root`;

const keepDeviceAwake = (): void => {
  runAdbCleanup(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 'wake screen');
  runAdbCleanup(['shell', 'wm', 'dismiss-keyguard'], 'dismiss keyguard');
  runAdbCleanup(['shell', 'svc', 'power', 'stayon', 'true'], 'keep screen on');
};

const cleanupFirefoxRuntime = (reason: string): void => {
  console.warn(`[android] Cleaning Firefox runtime (${reason}).`);
  runAdbCleanup(['shell', 'am', 'force-stop', FENIX_PACKAGE], 'force-stop Firefox Nightly');
};

const cleanupFirefoxSessionState = (reason: string): void => {
  cleanupFirefoxRuntime(reason);
  runAdbCleanup(['shell', 'pm', 'clear', FENIX_PACKAGE], 'clear Firefox Nightly data');
  runAdbCleanup(['shell', 'rm', '-rf', DEVICE_EXT_PATH], 'remove pushed extension');
  runAdbCleanup(['shell', 'rm', '-rf', FENIX_TEST_ROOT], 'remove geckodriver test root');
};

const getDeviceState = (): string | null => {
  try {
    const output = execFileSync(ADB_BIN, ['devices'], { encoding: 'utf-8' });
    for (const row of output.split(/\r?\n/)) {
      const [serial, state] = row.trim().split(/\s+/);
      if (serial === ADB_DEVICE_SERIAL) return state ?? null;
    }
    return null;
  } catch {
    return null;
  }
};

const waitForBoot = (timeoutMs = 120_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      let booted = false;
      try {
        const result = adbOutput(['shell', 'getprop', 'sys.boot_completed']).trim();
        booted = result === '1';
      } catch {
        // Device not ready yet
      }
      if (booted) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`Emulator did not boot within ${timeoutMs / 1000}s`));
      }
    }, 2000);
  });

const isPackageInstalled = (pkg: string): boolean => {
  try {
    const output = adbOutput(['shell', 'pm', 'list', 'packages', pkg]);
    return output.split('\n').some(line => line.trim() === `package:${pkg}`);
  } catch {
    return false;
  }
};

const getEmulatorArch = (): string => {
  try {
    return adbOutput(['shell', 'getprop', 'ro.product.cpu.abi']).trim();
  } catch {
    return 'x86_64';
  }
};

const findLatestBuildUrl = async (arch: string): Promise<string> => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthUrl = `${FENIX_ARCHIVE_BASE}/${year}/${month}/`;

  console.warn(`[android] Fetching nightly listing from ${monthUrl}`);
  const response = await fetch(monthUrl);
  if (!response.ok) throw new Error(`Failed to fetch nightly listing: ${response.status}`);
  const html = await response.text();

  const dirPattern = new RegExp(`href="([^"]*-android-${arch}/)"`, 'g');
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = dirPattern.exec(html)) !== null) lastMatch = m;
  if (!lastMatch) throw new Error(`No nightly build found for ${arch} at ${monthUrl}`);

  const buildHref = lastMatch[1];
  return buildHref.startsWith('/') ? `https://archive.mozilla.org${buildHref}` : `${monthUrl}${buildHref}`;
};

/**
 * Download the Firefox Nightly APK from archive.mozilla.org — the latest build,
 * or the one pinned via FENIX_NIGHTLY_BUILD (e.g. "2026/08/2026-08-27-09-45-44-fenix-156.0a1").
 * URL structure: /pub/fenix/nightly/{year}/{month}/{timestamp}-fenix-{version}-android-{arch}/fenix-{version}.multi.android-{arch}.apk
 * Caches the APK in node_modules/.cache/firefox-nightly/ to avoid re-downloading.
 */
const downloadFenixApk = async (arch: string): Promise<string> => {
  await mkdir(FENIX_CACHE_DIR, { recursive: true });

  const pinnedVersion = FENIX_PINNED_BUILD?.match(/fenix-([\d.a]+)/)?.[1];
  try {
    const cached = await readdir(FENIX_CACHE_DIR);
    const existing = cached.find(
      f => f.includes(arch) && f.endsWith('.apk') && (!pinnedVersion || f.includes(pinnedVersion)),
    );
    if (existing) {
      const apkPath = resolve(FENIX_CACHE_DIR, existing);
      console.warn(`[android] Using cached APK: ${apkPath}`);
      return apkPath;
    }
  } catch {
    // No cache yet
  }

  const buildUrl = FENIX_PINNED_BUILD
    ? `${FENIX_ARCHIVE_BASE}/${FENIX_PINNED_BUILD}-android-${arch}/`
    : await findLatestBuildUrl(arch);
  console.warn(`[android] Using build: ${buildUrl}`);
  const buildResponse = await fetch(buildUrl);
  if (!buildResponse.ok) throw new Error(`Failed to fetch build listing: ${buildResponse.status}`);
  const buildHtml = await buildResponse.text();

  const apkPattern = new RegExp(`href="([^"]*\\.multi\\.android-${arch}\\.apk)"`, 'i');
  const apkMatch = buildHtml.match(apkPattern);
  if (!apkMatch) throw new Error(`No APK found in ${buildUrl}`);

  const apkHref = apkMatch[1];
  const apkFilename = apkHref.split('/').pop() ?? apkHref;
  const apkUrl = apkHref.startsWith('/') ? `https://archive.mozilla.org${apkHref}` : `${buildUrl}${apkHref}`;
  const apkPath = resolve(FENIX_CACHE_DIR, apkFilename);

  console.warn(`[android] Downloading ${apkUrl}`);
  const apkResponse = await fetch(apkUrl);
  if (!apkResponse.ok || !apkResponse.body) throw new Error(`Failed to download APK: ${apkResponse.status}`);

  await pipeline(apkResponse.body, createWriteStream(apkPath));
  console.warn(`[android] Downloaded to ${apkPath}`);
  return apkPath;
};

const ensureFirefoxInstalled = async (): Promise<void> => {
  if (isPackageInstalled(FENIX_PACKAGE)) {
    console.warn('[android] Firefox Nightly already installed.');
    return;
  }

  // Allow explicit APK path via env var
  const explicitApk = process.env.FENIX_APK;
  if (explicitApk) {
    await stat(explicitApk);
    console.warn(`[android] Installing Firefox Nightly from ${explicitApk}`);
    adb(['install', explicitApk], { stdio: 'inherit' });
    return;
  }

  const arch = getEmulatorArch();
  console.warn(`[android] Firefox Nightly not installed. Downloading for ${arch}...`);
  const apkPath = await downloadFenixApk(arch);
  console.warn('[android] Installing Firefox Nightly...');
  adb(['install', apkPath], { stdio: 'inherit' });
  console.warn('[android] Firefox Nightly installed.');
};

const outputDir = resolve(import.meta.dirname, '../../../.output');
const firefoxUnpackedExtensionPath = resolve(outputDir, 'firefox-mv3');

// Resolve Firefox extension path (prefer unpacked dir, fall back to .zip)
let firefoxExtensionPath: string | undefined;
try {
  const unpackedStats = await stat(firefoxUnpackedExtensionPath);
  if (unpackedStats.isDirectory()) {
    firefoxExtensionPath = firefoxUnpackedExtensionPath;
  }
} catch {
  // Fall back to packaged artifact below.
}

if (!firefoxExtensionPath) {
  const files = await readdir(outputDir);
  const firefoxZip = files
    .filter(file => file.startsWith('haram-block-') && file.endsWith('-firefox.zip'))
    .sort((a, b) => {
      const versionA = a.match(/haram-block-(\d+\.\d+\.\d+)/)?.[1] || '0.0.0';
      const versionB = b.match(/haram-block-(\d+\.\d+\.\d+)/)?.[1] || '0.0.0';
      return versionA.localeCompare(versionB, undefined, { numeric: true });
    })
    .at(-1);
  if (!firefoxZip) {
    throw new Error(`No firefox build found in ${outputDir}`);
  }
  firefoxExtensionPath = resolve(outputDir, firefoxZip);
}

const androidCapabilities: WebdriverIO.Capabilities = {
  browserName: 'firefox',
  pageLoadStrategy: getPageLoadStrategy(),
  // Disable BiDi — geckodriver on Android doesn't support WebSocket URLs
  'wdio:enforceWebDriverClassic': true,
  'wdio:geckodriverOptions': {
    allowSystemAccess: true,
  },
  'moz:firefoxOptions': {
    androidPackage: 'org.mozilla.fenix',
    androidDeviceSerial: ADB_DEVICE_SERIAL,
    // Fenix's AutomatedLaunch: these launch-intent extras make HomeActivity
    // finish onboarding in-process and disable CFR/popup interruptions before
    // the first frame. "performancetest" is the long-standing hook (needs
    // emulator or USB-plugged + adb); "automationtest" (Fenix >=157,
    // 2026-08-24) needs only adb enabled.
    // These REPLACE geckodriver's default intent arguments, so the default
    // VIEW action/data must be repeated here.
    androidIntentArguments: [
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'about:blank',
      '--ez',
      'performancetest',
      'true',
      '--ez',
      'automationtest',
      'true',
    ],
    prefs: {
      'gfx.webrender.force-disabled': true,
      'layers.acceleration.disabled': true,
      ...(process.env.ANDROID_CONSOLE_TO_LOGCAT
        ? {
            'devtools.console.stdout.content': true,
            'devtools.console.stdout.chrome': true,
            'browser.dom.window.dump.enabled': true,
          }
        : {}),
    },
  },
} as WebdriverIO.Capabilities;

export const config: WebdriverIO.Config = {
  ...baseConfig,
  // Android geckodriver is more reliable with one long session. Repeated
  // sessions can leave Fenix/profile resources locked on CI.
  specs: SINGLE_SESSION ? [(baseConfig.specs ?? []) as string[]] : baseConfig.specs,
  capabilities: [androidCapabilities],
  maxInstances: 1,
  logLevel: 'warn',
  waitforTimeout: 15000,
  cucumberOpts: {
    ...baseConfig.cucumberOpts,
    tags: ANDROID_E2E_TAGS ?? 'not @desktop-only',
    timeout: 180000,
  },
  onPrepare: async () => {
    console.warn(
      `[android] ${SINGLE_SESSION ? 'Using one WebDriver session for all features' : 'Using one WebDriver session per feature'}.`,
    );
    console.warn(`[android] Page load strategy: ${androidCapabilities.pageLoadStrategy ?? 'normal'}.`);
    console.warn(`[android] Cleanup between sessions: ${CLEANUP_BETWEEN_SESSIONS ? 'enabled' : 'disabled'}.`);

    const deviceState = getDeviceState();
    if (deviceState) {
      console.warn(`[android] Device ${ADB_DEVICE_SERIAL} is ${deviceState}; waiting for boot.`);
      await waitForBoot();
      console.warn('[android] Emulator booted.');
    } else if (!MANAGE_EMULATOR) {
      throw new Error(
        `[android] No Android device found at ${ADB_DEVICE_SERIAL}. ` +
          'CI should start the emulator with android-emulator-runner before pnpm e2e:android. ' +
          'For local self-managed startup, set ANDROID_MANAGE_EMULATOR=true.',
      );
    } else {
      console.warn(`[android] Starting emulator: ${AVD_NAME}`);
      const emulatorArgs = [
        '-avd',
        AVD_NAME,
        '-no-snapshot-save',
        '-noaudio',
        '-no-boot-anim',
        ...(IS_CI ? ['-gpu', 'swiftshader_indirect'] : []),
        ...(IS_CI && !DEBUG_CI_MODE ? ['-no-window', '-no-metrics'] : []),
      ];
      const emulatorProcess = spawn(`"${EMULATOR_BIN}"`, emulatorArgs, {
        stdio: 'ignore',
        detached: true,
        shell: true,
      });
      emulatorProcess.unref();
      console.warn('[android] Waiting for emulator to boot...');
      await waitForBoot();
      console.warn('[android] Emulator booted.');
    }

    await ensureFirefoxInstalled();

    // Enable ADB root access for geckodriver profile push
    try {
      adb(['root'], { encoding: 'utf-8', stdio: 'pipe' });
      adb(['wait-for-device'], { stdio: 'pipe' });
      const shellReadyDeadline = Date.now() + 30_000;
      for (;;) {
        try {
          adb(['shell', 'true'], { stdio: 'pipe' });
          break;
        } catch (err) {
          if (Date.now() > shellReadyDeadline) throw err;
          await new Promise(done => setTimeout(done, 1000));
        }
      }
      console.warn('[android] ADB root enabled.');
    } catch {
      console.warn('[android] ADB root not available (expected on production emulator images).');
    }

    keepDeviceAwake();
    cleanupFirefoxSessionState('initial setup');
  },
  beforeSession: () => {
    if (CLEANUP_BETWEEN_SESSIONS) {
      cleanupFirefoxSessionState('before session');
    }
  },
  before: async (_capabilities: WebdriverIO.Capabilities, _specs: string[], browser: WebdriverIO.Browser) => {
    if (!firefoxExtensionPath) {
      throw new Error('Firefox extension path not set');
    }

    // Keep the session's initial tab open and create a fresh one: Android
    // geckodriver can return no remaining handles from closeWindow(), which
    // makes WebdriverIO terminate the entire session.
    const { handle } = await browser.createWindow('tab');
    await browser.switchToWindow(handle);

    // With pageLoadStrategy 'none', browser.url() returns before the page
    // loads. Override it to wait for navigation to actually complete by
    // setting a JS marker on the old page and polling until it disappears.
    browser.overwriteCommand('url', async (origFn, path: string) => {
      const waitForNavigation = async (): Promise<void> => {
        let markerSet = false;
        try {
          await browser.execute(() => {
            (globalThis as Record<string, unknown>).__wdioNav = true;
          });
          markerSet = true;
        } catch {
          /* page might be dead/unavailable */
        }

        const prevUrl = markerSet ? null : await browser.getUrl().catch(() => '');
        await origFn(path);

        await browser.waitUntil(
          async () => {
            try {
              if (markerSet) {
                const marker = await browser.execute(() => (globalThis as Record<string, unknown>).__wdioNav);
                if (marker === true) return false;
              } else if (prevUrl !== null) {
                if ((await browser.getUrl()) === prevUrl) return false;
              }
              return await browser.execute(
                () => document.readyState === 'interactive' || document.readyState === 'complete',
              );
            } catch {
              return false;
            }
          },
          { timeout: 30000, interval: 300 },
        );
      };

      const landedOnTarget = async (): Promise<boolean> => {
        const currentUrl = await browser.getUrl().catch(() => '');
        if (!currentUrl) return false;
        return currentUrl.startsWith(path) || path.startsWith(currentUrl);
      };

      await waitForNavigation();

      const MAX_NAVIGATION_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_NAVIGATION_ATTEMPTS; attempt++) {
        if (await landedOnTarget()) return;
        const currentUrl = await browser.getUrl().catch(() => '');
        console.warn(
          `[android] Navigation to ${path} landed on ${currentUrl}; recovering (attempt ${attempt}/${MAX_NAVIGATION_ATTEMPTS}).`,
        );
        keepDeviceAwake();
        await waitForNavigation();
      }
      const finalUrl = await browser.getUrl().catch(() => '');
      throw new Error(`[android] Navigation to ${path} failed; stuck on ${finalUrl}`);
    });

    // Install extension via moz/addon/install. Firefox runs on Android so we push
    // the extension to the device via ADB and use the device-local path.
    adb(['shell', 'rm', '-rf', DEVICE_EXT_PATH], { stdio: 'pipe' });
    adb(['push', firefoxExtensionPath, DEVICE_EXT_PATH], { stdio: 'pipe' });
    console.warn('[android] Extension pushed to device.');

    await browser.call(async () => {
      const { sessionId } = browser;
      const { protocol, hostname, port } = browser.options as { protocol: string; hostname: string; port: number };
      const url = `${protocol}://${hostname}:${port}/session/${sessionId}/moz/addon/install`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: DEVICE_EXT_PATH, temporary: true }),
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to install addon: ${error}`);
      }
      console.warn('[android] Extension installed.');
    });

    // Resolve moz-extension:// UUID and verify popup is reachable
    const extUrl = await getExtensionPath(browser, ADDON_ID);
    console.warn(`[android] Extension URL: ${extUrl}`);

    await browser.url(`${extUrl}/popup.html`);
    await $('[data-testid="policy-toggle"]').waitForDisplayed({ timeout: 15000 });
    const title = await browser.getTitle();
    console.warn(`[android] popup.html title: "${title}"`);

    browser.addCommand('getExtensionPath', () => getExtensionPath(browser, ADDON_ID));
  },
};
