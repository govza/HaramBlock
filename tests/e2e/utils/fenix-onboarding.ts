import { adb, adbOutput, runAdbCleanup } from './android.js';

/**
 * Fenix gates first launch behind a native Terms-of-Use / "set as default browser"
 * onboarding flow. It renders above GeckoView, so the web page underneath loads and
 * answers DOM queries while every pointer interaction fails as non-interactable —
 * which is why a run dies on its first click() with every preceding DOM assertion green.
 *
 * geckodriver speaks WebDriver to Gecko only and has no native context, so these views
 * are unreachable from `browser.$()`. Driving them over adb is the workaround; switching
 * the harness to Appium's uiautomator2 driver would be the principled fix.
 *
 * Best-effort by design: if the buttons are absent (older build, changed copy, flow
 * removed upstream) this leaves the device untouched rather than failing the run.
 */

const UI_DUMP_DEVICE_PATH = '/sdcard/haramblock-ui-dump.xml';
const BUTTON_LABELS = ['Continue', 'Not now', 'Skip', 'Start browsing', 'Got it'];
const MAX_STEPS = 8;
const STEP_SETTLE_MS = 2500;

type OnboardingButton = { label: string; x: number; y: number };

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

const dumpUi = (): string | null => {
  try {
    adb(['shell', 'uiautomator', 'dump', UI_DUMP_DEVICE_PATH], { stdio: 'pipe' });
    return adbOutput(['shell', 'cat', UI_DUMP_DEVICE_PATH]);
  } catch {
    return null;
  }
};

const attribute = (node: string, name: string): string | null =>
  node.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

const centerOf = (bounds: string | null): { x: number; y: number } | null => {
  const match = bounds?.match(/^\[(\d+),(\d+)]\[(\d+),(\d+)]$/);
  if (!match) return null;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
};

/**
 * Attributes are read per node rather than with one regex across the element so the
 * match does not depend on uiautomator's attribute ordering. Fenix exposes the label
 * on a non-clickable child of the button, so the text-bearing node itself must not be
 * required to carry the parent's clickable state.
 */
export const findOnboardingButton = (xml: string): OnboardingButton | null => {
  for (const node of xml.match(/<node\b[^>]*>/g) ?? []) {
    const label = attribute(node, 'text');
    if (!label || !BUTTON_LABELS.includes(label)) continue;

    const center = centerOf(attribute(node, 'bounds'));
    if (center) return { label, ...center };
  }

  return null;
};

const findOnboardingButtonOnDevice = (): OnboardingButton | null => {
  const xml = dumpUi();
  return xml ? findOnboardingButton(xml) : null;
};

export const dismissFenixOnboarding = async (): Promise<void> => {
  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const button = findOnboardingButtonOnDevice();
      if (!button) {
        if (step > 0) console.warn('[android] Onboarding dismissed.');
        return;
      }

      console.warn(`[android] Dismissing onboarding: "${button.label}"`);
      try {
        adb(['shell', 'input', 'tap', String(button.x), String(button.y)], { stdio: 'pipe' });
      } catch (err) {
        console.warn(`[android] Onboarding tap failed: ${(err as Error)?.message ?? err}`);
        return;
      }

      // eslint-disable-next-line no-await-in-loop -- each onboarding page must settle before the next UI dump
      await sleep(STEP_SETTLE_MS);
    }
    console.warn(`[android] Onboarding still present after ${MAX_STEPS} steps; continuing anyway.`);
  } finally {
    runAdbCleanup(['shell', 'rm', '-f', UI_DUMP_DEVICE_PATH], 'remove UI dump');
  }
};
