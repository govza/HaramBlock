const CONSENT_PAGE_PATTERN = /^(chrome|moz)-extension:\/\/[^/]+\/consent\.html/;
const CONSENT_TAB_APPEAR_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

const urlOf = async (browser: WebdriverIO.Browser, handle: string): Promise<string> => {
  await browser.switchToWindow(handle);
  return browser.getUrl().catch(() => '');
};

const findConsentHandles = async (browser: WebdriverIO.Browser, handles: string[]): Promise<string[]> => {
  const consentHandles: string[] = [];
  for (const handle of handles) {
    if (CONSENT_PAGE_PATTERN.test(await urlOf(browser, handle))) consentHandles.push(handle);
  }
  return consentHandles;
};

/**
 * The extension opens its Cloud Predictions consent tab on install. Left open, it becomes the
 * browser's active tab, which backgrounds the window the steps drive (paused rAF, throttled
 * timers). Closes it once it appears and gives focus back to a remaining window. Never closes the
 * last window: Android geckodriver ends the session when no handle remains.
 */
export const closeConsentTabOpenedOnInstall = async (browser: WebdriverIO.Browser): Promise<void> => {
  const startHandle = await browser.getWindowHandle();
  const deadline = Date.now() + CONSENT_TAB_APPEAR_TIMEOUT_MS;
  let handles = await browser.getWindowHandles();
  let consentHandles = await findConsentHandles(browser, handles);

  while (consentHandles.length === 0 && Date.now() < deadline) {
    await browser.pause(POLL_INTERVAL_MS);
    handles = await browser.getWindowHandles();
    consentHandles = await findConsentHandles(browser, handles);
  }

  const remaining = handles.filter(handle => !consentHandles.includes(handle));
  const closable = remaining.length > 0 ? consentHandles : consentHandles.slice(1);
  for (const handle of closable) {
    await browser.switchToWindow(handle);
    await browser.closeWindow();
  }

  const keep = remaining.includes(startHandle) ? startHandle : (remaining[0] ?? consentHandles[0]);
  if (keep) await browser.switchToWindow(keep);
};
