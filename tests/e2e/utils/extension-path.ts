import { isMobile } from './platform.js';

let cachedExtensionPath: string | null = null;

const getChromeExtensionPath = async (browser: WebdriverIO.Browser) => {
  await browser.url('chrome://extensions/');

  const extensionsManager = await $('extensions-manager').getElement();
  const itemList = await extensionsManager.shadow$('#container > #viewManager > extensions-item-list').getElement();
  const extensionItem = await itemList.shadow$('extensions-item').getElement();

  const extensionId = await extensionItem.getAttribute('id');

  if (!extensionId) {
    throw new Error('Extension ID not found');
  }

  return `chrome-extension://${extensionId}`;
};

const getFirefoxExtensionPath = async (browser: WebdriverIO.Browser) => {
  await browser.url('about:debugging#/runtime/this-firefox');
  const uuidElement = await browser.$('//dt[contains(text(), "Internal UUID")]/following-sibling::dd').getElement();
  const internalUUID = await uuidElement.getText();

  if (!internalUUID) {
    throw new Error('Internal UUID not found');
  }

  return `moz-extension://${internalUUID}`;
};

const setMozContext = async (browser: WebdriverIO.Browser, context: 'chrome' | 'content') => {
  const { sessionId } = browser;
  const hostname = browser.options.hostname ?? '127.0.0.1';
  const port = browser.options.port ?? 4444;
  const res = await fetch(`http://${hostname}:${port}/session/${sessionId}/moz/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
  });
  if (!res.ok) {
    throw new Error(`Failed to set moz context to "${context}": ${res.status} ${await res.text()}`);
  }
};

const getFirefoxExtensionPathAndroid = async (browser: WebdriverIO.Browser, addonId: string) => {
  await setMozContext(browser, 'chrome');

  /* eslint-disable no-await-in-loop, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
  let uuid: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    uuid = await browser.execute((id: string) => {
      const g = globalThis as any;

      try {
        const Cc = g.Components?.classes;
        const Ci = g.Components?.interfaces;
        if (Cc && Ci) {
          const prefs = Cc['@mozilla.org/preferences-service;1']?.getService(Ci.nsIPrefBranch);
          if (prefs) {
            const uuidsJson = prefs.getStringPref('extensions.webextensions.uuids', '{}');
            const uuids = JSON.parse(uuidsJson);
            if (uuids[id]) return uuids[id];
          }
        }
      } catch {
        /* not available */
      }

      try {
        const prefs = g.Services?.prefs;
        if (prefs) {
          const uuidsJson = prefs.getStringPref('extensions.webextensions.uuids', '{}');
          const uuids = JSON.parse(uuidsJson);
          if (uuids[id]) return uuids[id];
        }
      } catch {
        /* not available */
      }

      const available = ['Components', 'Services', 'ChromeUtils', 'Cc', 'Ci', 'Cu'].filter(
        name => typeof g[name] !== 'undefined',
      );
      return `__diag:${available.join(',')}`;
    }, addonId);

    if (uuid && !uuid.startsWith('__diag:')) break;
    if (uuid?.startsWith('__diag:')) {
      console.warn(`[android] Chrome context globals available: ${uuid.slice(7) || '(none)'}`);
      uuid = null;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  await setMozContext(browser, 'content');

  if (!uuid) {
    throw new Error(`Could not resolve UUID for addon ${addonId} on Android Firefox`);
  }

  return `moz-extension://${uuid}`;
};

export const getExtensionPath = async (browser: WebdriverIO.Browser, addonId?: string): Promise<string> => {
  if (cachedExtensionPath) return cachedExtensionPath;

  const { browserName } = browser.capabilities;

  if (browserName === 'chrome') {
    cachedExtensionPath = await getChromeExtensionPath(browser);
  } else if (browserName === 'firefox') {
    if (isMobile()) {
      if (!addonId) throw new Error('addonId is required for Android Firefox');
      cachedExtensionPath = await getFirefoxExtensionPathAndroid(browser, addonId);
    } else {
      cachedExtensionPath = await getFirefoxExtensionPath(browser);
    }
  } else {
    throw new Error(`Unsupported browser: ${browserName}`);
  }

  return cachedExtensionPath;
};
