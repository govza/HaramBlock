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

**Important:** If you've modified extension code, rebuild before running tests:

```bash
# Build extension first (required after code changes)
pnpm zip

# Run all e2e tests
pnpm e2e

# Run tests by tag (e.g., @policy, @masking, @quick-toggle)
pnpm e2e --cucumberOpts.tagExpression="@policy"
```

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

#### Avoid Explicit Timeouts

Never use `browser.pause()` with arbitrary delays when there's something concrete to wait for.
Instead, use `browser.waitUntil()` with a condition:

```typescript
// ❌ Bad - arbitrary timeout
await browser.pause(5000);

// ✅ Good - wait for specific condition (uses default timeout from config)
await browser.waitUntil(async () =>
  browser.execute((img: HTMLElement) => img.complete && img.naturalHeight > 0, image)
);

// ✅ Good - wait for element attribute
await browser.waitUntil(async () => (await element.getAttribute('data-processed')) !== null);
```

Don't specify `{ timeout: ... }` unless you need a value different from the configured default.
Explicit pauses make tests slow and flaky. Only use them when there's genuinely no observable state
to wait for (e.g., waiting for React state to settle after a click).

#### Wait After Popup Clicks

The popup uses React with async state updates. Pause after clicking buttons to allow state to
settle:

```typescript
await policyButton.click();
await browser.pause(300);
```

No pause is needed after navigation - `waitUntil` assertions handle async waiting.

#### Verify State Changes After Toggle Clicks

When toggling settings that persist to IndexedDB, always verify the state actually changed before
proceeding. Extension state updates are async and may fail silently:

```typescript
const isChecked = await checkbox.isSelected();
if (isChecked !== enabled) {
  await browser.execute((el: HTMLElement) => el.click(), label);
  await browser.pause(500);
  // Verify the toggle changed
  const newState = await checkbox.isSelected();
  if (newState !== enabled) {
    throw new Error(`Failed to set toggle to ${enabled}. Current state: ${newState}`);
  }
}
```

This pattern catches cases where clicks don't register or state doesn't persist correctly.

### Adding Test IDs to Components

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
