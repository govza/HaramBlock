# HaramBlock — Claude Code Notes

- Documentation entry point: [docs/INDEX.md](docs/INDEX.md). Domain vocabulary lives in the docs it
  links (media terms in MEDIA_PROCESSING.md, video terms in VIDEO_PROCESSING.md).
- **Browser debugging via Playwright MCP** (drives Chromium with the built extension installed):
  [docs/PLAYWRIGHT.md](docs/PLAYWRIGHT.md). Rebuild with `pnpm build` before launching the browser —
  the MCP loads the static output in `.output/chrome-mv3`.
  - Use the Playwright MCP only in rare cases where browser automation is explicitly needed. Prefer
    asking the user to test manually first. When automation is warranted, delegate the
    browser-driving to a subagent on a cheaper/lighter model (e.g. Haiku) instead of running it from
    the main session.

## Agent skills

### Issue tracker

Issues and PRDs live in the repo's GitHub Issues (`govza/HaramBlock`), managed via the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: vocabulary lives in the subsystem docs indexed by `docs/INDEX.md`; `CONTEXT.md` and
`docs/adr/` are created lazily on top. See `docs/agents/domain.md`.
