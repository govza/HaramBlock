import { Given, Then } from '@wdio/cucumber-framework';

interface LogEntry {
  level: string;
  text: string | null;
}

interface LogEntryAddedEvent {
  entry?: Partial<LogEntry>;
  level?: string;
  text?: string | null;
}

let capturedLogs: LogEntry[] = [];
let subscribed = false;

const findDisplayedElement = async (selector: string, timeout: number): Promise<WebdriverIO.Element> => {
  await browser.waitUntil(
    async () => {
      const matches = await $$(selector);
      for (const match of matches) {
        if (await match.isDisplayed()) {
          return true;
        }
      }
      return false;
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `No displayed element found for selector: ${selector}`,
    },
  );

  const matches = await $$(selector);
  for (const match of matches) {
    if (await match.isDisplayed()) {
      return match;
    }
  }

  throw new Error(`No displayed element found for selector: ${selector}`);
};

const normalizeLogEntry = (rawEntry: LogEntryAddedEvent): LogEntry | null => {
  const entry = rawEntry.entry ?? rawEntry;
  const text = typeof entry.text === 'string' ? entry.text : null;
  if (!text) {
    return null;
  }

  return {
    level: typeof entry.level === 'string' ? entry.level.toLowerCase() : 'info',
    text,
  };
};

const formatCapturedLogs = (): string => {
  if (capturedLogs.length === 0) {
    return 'none';
  }

  return capturedLogs
    .slice(-3)
    .map(({ level, text }) => `[${level}] ${text}`)
    .join(' | ');
};

Given('I start capturing extension console errors', () => {
  capturedLogs = [];
  if (!subscribed) {
    browser.on('log.entryAdded', (rawEntry: LogEntryAddedEvent) => {
      const entry = normalizeLogEntry(rawEntry);
      if (entry?.text?.includes('HaramBlock')) {
        capturedLogs.push(entry);
      }
    });
    subscribed = true;
  }
});

Given('extension console logging is enabled', async () => {
  const extensionPath = await browser.getExtensionPath();
  await browser.url(`${extensionPath}/popup.html`);

  const helpBtn = await findDisplayedElement('[data-testid="help-toggle"]', 15000);
  await helpBtn.click();

  const consoleBtn = await findDisplayedElement('[data-testid="console-toggle"]', 5000);
  await consoleBtn.click();
  await browser.pause(500);
});

Then('there should be no HaramBlock console errors', async () => {
  await browser.pause(2000);
  const errors = capturedLogs.filter(e => e.level === 'error');
  if (errors.length > 0) {
    throw new Error(`Unexpected HaramBlock console errors: ${formatCapturedLogs()}`);
  }
});

Then('the content script should have initialized', async () => {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        return document.getElementById('haramblock-prediction-styles') !== null;
      }),
    {
      timeout: 30000,
      interval: 500,
      timeoutMsg: 'Content script did not inject prediction styles within 30s',
    },
  );
});
