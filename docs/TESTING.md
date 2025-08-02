# Testing Guide

This project uses [Vitest](https://vitest.dev/) for unit testing, following the
[WXT testing guide](https://wxt.dev/guide/essentials/unit-testing.html).

## Running Tests

```bash
# Run tests once
npm run test:unit
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
