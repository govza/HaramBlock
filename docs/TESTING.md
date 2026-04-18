# Testing Guide

This project uses [Vitest](https://vitest.dev/) for unit testing, following the
[WXT testing guide](https://wxt.dev/guide/essentials/unit-testing.html).

## Running Tests

```bash
# Run tests once
pnpm test:unit
```

To run a single test file:

```bash
pnpm test:unit utils/db/__tests__/hostSettings.test.ts
```

## Test Setup

The tests use Vitest with WXT's testing plugin, which provides:

- Browser extension API mocking
- TypeScript support
- ES modules support
- Fast test execution

## Database Mocking

Database operations are mocked using `vi.mock()` to avoid actual IndexedDB operations during
testing:

```typescript
vi.mock('@/utils/db/db', () => ({
  hostSettingsDb: {
    hostSettings: {
      put: vi.fn(),
      get: vi.fn()
    }
  }
}));
```

This ensures tests run quickly and don't interfere with actual browser storage.

## E2E Testing

E2E tests use [WebdriverIO](https://webdriver.io/) with [Cucumber](https://cucumber.io/) framework.

### Running E2E Tests

**Important:** If you've modified extension code, rebuild before running tests. `pnpm build` is
faster for local development; CI uses `pnpm zip` to validate the full packaging pipeline.

```bash
# Build extension first (required after code changes)
pnpm build

# Run all e2e tests
pnpm e2e

# Run tests by tag (e.g., @policy, @masking, @quick-toggle)
pnpm e2e -- --debug --cucumberOpts.tags="@policy"

# Run tests by scenario name
pnpm e2e -- --debug --cucumberOpts.name="Segment outline on large images"

# Run smoke tests only (quick validation)
pnpm e2e -- --debug --cucumberOpts.tags="@smoke"
```

#### Debugging E2E Tests

The `--debug` flag is the primary tool for investigating E2E test failures. It runs the tests with
CI-like settings (no-sandbox, disabled GPU) but keeps the browser **visible** instead of headless,
so you can watch exactly what the tests are doing:

```bash
# Run tests with visible browser (CI-like environment)
pnpm e2e -- --debug

# Combine with tag filters to debug a specific scenario
pnpm e2e -- --debug --cucumberOpts.tags="@masking"
```

This is especially useful for reproducing CI-only failures locally — the browser runs with the same
flags CI uses (SwiftShader, no-sandbox, etc.) but you can see the UI and open DevTools to inspect
state.

#### Firefox E2E Tests

To run E2E tests on Firefox, build the Firefox extension zip and use the Firefox-specific command:

```bash
# Build Firefox extension
pnpm build:firefox

# Run E2E tests on Firefox
pnpm e2e:firefox
```

#### Firefox Android Manual Testing

To test the extension on Firefox for Android:

1. **Enable USB debugging** on your Android device (Settings → Developer options)
2. **Enable remote debugging** in Firefox Android (Settings → Advanced → Remote debugging via USB)
3. **Connect your device** via USB and verify with `adb devices`

```bash
# Build the Firefox extension
pnpm build:firefox

# Run on Firefox Android (replace DEVICE_ID with your device)
web-ext run -s .output/firefox-mv3 --target=firefox-android --adb-device=DEVICE_ID --firefox-apk=org.mozilla.firefox

# Or use Firefox Nightly (recommended for development)
web-ext run -s .output/firefox-mv3 --target=firefox-android --adb-device=DEVICE_ID --firefox-apk=org.mozilla.fenix
```

Use [scrcpy](https://github.com/Genymobile/scrcpy) to mirror your Android screen to your PC for
easier testing.

#### Firefox Android Emulator E2E Tests

Automated E2E tests can run on Firefox Nightly inside an Android emulator using geckodriver directly
(no Appium). This reuses the existing Cucumber features. Hover-dependent scenarios (`@quick-toggle`,
`@quick-toggle-click`) use tap/click instead of hover on mobile.

**Prerequisites:**

1. **Android SDK** with emulator and platform-tools (`adb`)
2. **An Android emulator AVD** (API 34+ recommended, x86_64 with Google APIs)
3. **geckodriver** npm package (included in devDependencies)

The local test harness handles the rest automatically: it starts the emulator if not already
running, downloads and installs Firefox Nightly from archive.mozilla.org (cached in
`node_modules/.cache/firefox-nightly/`), launches geckodriver with `--allow-system-access`, and
installs the extension as a temporary addon.

In GitHub Actions, the emulator is owned by `reactivecircus/android-emulator-runner`. The WDIO
Android config expects that action-managed emulator to already be booted when `CI=true`. The CI
workflow sets `ANDROID_SINGLE_SESSION=true` so all features run in one WebDriver session, since
repeated geckodriver sessions can leave Fenix profile resources locked on CI.

**Setup:**

```bash
# 1. Build the Firefox extension
pnpm build:firefox

# 2. (Optional) Start the emulator manually, or let the harness start it
emulator -avd Pixel_3a_API_34_extension_level_7_x86_64
```

**Running tests:**

```bash
# Run all mobile-compatible tests
pnpm e2e:android

# Run tests by tag
pnpm e2e:android -- --cucumberOpts.tags="@whitelist"

# Run smoke tests only
pnpm e2e:android -- --cucumberOpts.tags="@smoke"
```

**Environment variables:**

| Variable                           | Description                                            | Default                                    |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| `AVD_NAME`                         | Android emulator AVD name                              | `Pixel_3a_API_34_extension_level_7_x86_64` |
| `ANDROID_HOME`                     | Android SDK path                                       | `$LOCALAPPDATA/Android/Sdk`                |
| `ADB_DEVICE_SERIAL`                | ADB device serial (from `adb devices`)                 | `emulator-5554`                            |
| `FENIX_APK`                        | Path to a local Firefox Nightly APK (skips download)   | _(auto-download)_                          |
| `ANDROID_MANAGE_EMULATOR`          | Start the emulator from WDIO if no device is attached  | `true` locally, `false` in CI              |
| `ANDROID_SINGLE_SESSION`           | Reuse one WebDriver session for all feature files      | `true` locally, `false` in CI              |
| `ANDROID_PAGE_LOAD_STRATEGY`       | Firefox Android page-load strategy                     | `none`                                     |
| `ANDROID_CLEANUP_BETWEEN_SESSIONS` | Force-stop and clear Firefox state before each session | `false`                                    |
| `ANDROID_E2E_TAGS`                 | Optional Cucumber tag expression                       | _(all Android specs)_                      |

**How it works:**

1. `onPrepare` verifies the emulator is booted, starts it only when configured to do so, installs
   Firefox Nightly, enables ADB root when available, and clears Firefox state
2. `before` hook pushes the extension to the device via ADB, installs it as a temporary addon via
   the `moz/addon/install` endpoint, then resolves the `moz-extension://` UUID by reading the
   `extensions.webextensions.uuids` pref through the privileged Marionette chrome context
3. Tests run against Firefox Nightly on the emulator using the same Cucumber step definitions as
   desktop

**Notes:**

- geckodriver is spawned directly (no Appium) to avoid `platformName` mismatch issues
- The `--allow-system-access` flag on geckodriver enables the Marionette chrome context, which is
  needed to resolve the extension's internal UUID via XPCOM
- Local runs default to one WebDriver session (CI runs would default to per-feature, so the CI
  workflow sets `ANDROID_SINGLE_SESSION=true` explicitly) because repeated Firefox Android sessions
  can leave Fenix/geckodriver state locked; set `ANDROID_SINGLE_SESSION=false` only when debugging
  session isolation
- `ANDROID_CLEANUP_BETWEEN_SESSIONS=true` clears Fenix/geckodriver state before each new session,
  but it should only be used with `ANDROID_SINGLE_SESSION=false`
- For a smaller local or CI smoke run, set `ANDROID_E2E_TAGS="@smoke"` or pass
  `--cucumberOpts.tags="@smoke"`
- Hover-dependent steps automatically use tap/click on mobile (detected via the `platformName`
  capability)
- Emulator is slower than desktop — timeouts are increased accordingly (180s cucumber, 15s waitfor)
- If geckodriver gets stuck from a previous run, kill it: `npx kill-port 4444`

### Project Structure

```
tests/e2e/
├── config/           # WebdriverIO configuration
├── constants/        # Shared constants (selectors, timeouts)
├── features/         # Cucumber feature files (.feature)
└── step-definitions/ # Step definition files (.steps.ts)
```

### Writing Step Definitions

#### Use `.getElement()` and `.getElements()` for Proper Element Resolution

Always call `.getElement()` or `.getElements()` to get actual WebdriverIO elements:

```typescript
// ✅ Correct
const button = await $('[data-testid="policy-toggle"]').getElement();
const images = await $$(Selectors.GALLERY_IMAGE).getElements();

// ❌ Avoid - may cause issues with chained promises
const button = await $('[data-testid="policy-toggle"]');
```

#### Use WebdriverIO Element Methods Over `browser.execute()`

Prefer built-in element methods over `browser.execute()` for standard DOM interactions:

```typescript
// ✅ Use element methods
await element.click();
await element.moveTo();
await element.scrollIntoView({ block: 'center' });
const checked = await checkbox.getProperty('checked');
const disabled = await checkbox.getProperty('disabled');

// ❌ Avoid browser.execute for standard interactions
await browser.execute((el: HTMLElement) => el.click(), element);
await browser.execute(el => (el as HTMLInputElement).checked, checkbox);
```

Reserve `browser.execute()` for cases where you need to run arbitrary JS in the page context (e.g.,
checking `document.getElementById()`, dispatching custom events, or accessing APIs not exposed by
WebdriverIO).

#### Use `waitForDisplayed()` for Visibility Assertions

Use WebdriverIO's built-in `waitForDisplayed()` instead of custom polling loops:

```typescript
// ✅ Wait for element to become visible
const eyeToggle = await $(Selectors.EYE_TOGGLE).getElement();
await eyeToggle.waitForDisplayed({ timeout: 5000 });

// ✅ Wait for element to become hidden (reverse: true)
await eyeToggle.waitForDisplayed({
  timeout: 3000,
  reverse: true,
  timeoutMsg: 'Expected element to be hidden'
});

// ❌ Don't write custom visibility polling
await browser.waitUntil(async () => await element.isDisplayed(), { timeout: 5000 });
```

When asserting an element is NOT visible, guard against the element not existing in the DOM:

```typescript
const element = await $(selector).getElement();
const exists = await element.isExisting();
if (!exists) return; // not in DOM — not visible, assertion passes

await element.waitForDisplayed({ reverse: true, timeout: 3000 });
```

#### Separate Actions from Assertions

Never re-trigger an action inside an assertion polling loop. This is especially important for
interactions with debounced or delayed UI — re-triggering resets the delay and the assertion can
never succeed:

```typescript
// ❌ Bug: re-hovering resets the extension's 500ms show timer on every poll iteration
await browser.waitUntil(
  async () => {
    await image.moveTo(); // resets timer each time
    return element.isDisplayed(); // checks before timer fires
  },
  { timeout: 10000, interval: 1000 }
);

// ✅ Hover once, then wait for the result
await image.moveTo();
await eyeToggle.waitForDisplayed({ timeout: 5500 });
```

#### Mirror Extension Timing Constants

When tests depend on extension timers (show delays, auto-hide), define matching constants with a
source reference so they stay in sync:

```typescript
// Extension timing constants (from quickToggle.ts)
const SHOW_DELAY_MS = 500;
const HIDE_DELAY_MS = 2500;

// Use them in timeouts — add buffer for async overhead
await eyeToggle.waitForDisplayed({ timeout: SHOW_DELAY_MS + 5000 });
await browser.pause(HIDE_DELAY_MS + 1000);
```

#### Use `moveTo()` for Hover Interactions

Use WebdriverIO's `moveTo()` for hover, which fires real browser-level mouse events (`mouseenter`,
`mouseover`, etc.). Don't dispatch synthetic `MouseEvent`s:

```typescript
// ✅ Real browser hover
const image = await $(Selectors.GALLERY_IMAGE).getElement();
await image.scrollIntoView({ block: 'center' });
await image.moveTo();

// ❌ Don't dispatch synthetic events
await browser.execute((el: HTMLElement) => {
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
}, image);
```

#### Use `Array.from()` for Element Arrays

WebdriverIO element arrays aren't directly iterable with Array methods:

```typescript
// ✅ Correct
const images = await $$(selector).getElements();
const results = await Promise.all(Array.from(images).map(img => img.getAttribute('data-attr')));

// ❌ Will throw "object is not iterable"
const results = await Promise.all(images.map(img => img.getAttribute('data-attr')));
```

#### Check Attribute Existence with `null`

When checking if an attribute exists (even with empty value), compare to `null`:

```typescript
// ✅ Correct - attribute exists with empty value ""
const attr = await element.getAttribute('data-haramblock-blacklist');
if (attr === null) return false; // attribute doesn't exist

// ❌ Wrong - empty string "" is falsy
if (!attr) return false; // fails for data-attr=""
```

#### Handle Sequential Awaits in Loops

Use `eslint-disable-next-line` for intentional sequential operations:

```typescript
const clickUntilPolicy = async (button: WebdriverIO.Element, target: string): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    const current = await button.getAttribute('data-policy');
    if (current === target) return;
    // eslint-disable-next-line no-await-in-loop
    await button.click();
  }
};
```

#### Never Register Duplicate Step Definitions

Registering the same pattern with different keywords causes steps to be skipped silently:

```typescript
// ✅ Correct - register once with Given (keywords are interchangeable)
Given('I set the policy to {string}', async (policy: string) => { ... });

// ❌ Wrong - duplicate registration
Given('I set the policy to {string}', async (policy: string) => { ... });
When('I set the policy to {string}', async (policy: string) => { ... });
```

#### Prefer `waitUntil()` Over `browser.pause()`

[`browser.pause()`](https://webdriver.io/docs/api/browser/pause/) halts execution for a fixed
duration. WebdriverIO explicitly recommends against using it to wait for elements — use explicit
wait commands instead to avoid flaky tests.

```typescript
// ❌ Bad - arbitrary timeout, causes flaky tests
await browser.pause(5000);

// ✅ Good - wait for element attribute
await browser.waitUntil(async () => (await element.getAttribute('data-processed')) !== null);

// ✅ Good - wait for element to appear
await element.waitForDisplayed({ timeout: 5000 });

// ✅ Good - wait for element to disappear
await element.waitForDisplayed({ reverse: true, timeout: 3000 });

// ✅ Good - wait for element to exist in DOM
await element.waitForExist({ timeout: 5000 });
```

Acceptable uses of `browser.pause()`:

- Waiting for React state to settle after a popup click (`300-500ms`)
- Waiting for a timer-based behavior where there's no observable state change (e.g., auto-hide
  timeout)

#### Verify State Changes After Toggle Clicks

When toggling settings that persist to IndexedDB, always verify the state actually changed before
proceeding. Extension state updates are async and may fail silently:

```typescript
const isChecked = await checkbox.getProperty('checked');
if (isChecked !== enabled) {
  const label = await toggleRow.$('label').getElement();
  await label.click();
  await browser.waitUntil(async () => (await checkbox.getProperty('checked')) === enabled, {
    timeout: 5000,
    timeoutMsg: `Failed to set toggle to ${enabled}`
  });
}
```

### Adding Test IDs

Add `data-testid` attributes to components for reliable test targeting:

```tsx
<button
  onClick={togglePolicy}
  data-testid='policy-toggle'
  data-policy={hostSettings.policy}
>
```

Use descriptive `data-testid` values and include state in `data-*` attributes when needed for
assertions.
