# Source Code Review Instructions

This guide is intended for reviewers (store submission review, security review, etc.). For general
project docs, see `docs/INDEX.md`. For end-user usage, see `README.md`.

## Prerequisites

- Node.js v18+
- pnpm

## Build Steps

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Build release ZIPs:

   ```bash
   # Chrome
   pnpm zip

   # Firefox
   pnpm zip:firefox
   ```

3. Output will be in `.output/` directory.

## Unpacked Build (Optional)

If you prefer an unpacked build for manual testing:

```bash
pnpm build          # .output/chrome-mv3
pnpm build:firefox  # .output/firefox-mv3
```

## Verification

To verify the build matches the submitted extension, compare the contents of the generated ZIP with
the submitted extension.

## Additional Commands

- Run tests: `pnpm test:unit`
- Lint: `pnpm lint`
- Type check: `pnpm compile`

## Contact

- Author: Rasul Abu Muhammad Amin
- Email: admin@haramblock.com
- Repository: https://github.com/govza/HaramBlock
