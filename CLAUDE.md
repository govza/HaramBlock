# HaramBlock — Claude Code Notes

- Documentation entry point: [docs/INDEX.md](docs/INDEX.md). Domain vocabulary lives in the docs it
  links (media terms in MEDIA_PROCESSING.md, video terms in VIDEO_PROCESSING.md).
- **Browser debugging**: [docs/BROWSER_DEBUGGING.md](docs/BROWSER_DEBUGGING.md) is the playbook
  (chrome-devtools MCP + `pnpm dev` browser as the primary setup). The Playwright MCP with a static
  `pnpm build` is the alternative setup — [docs/PLAYWRIGHT.md](docs/PLAYWRIGHT.md).
  - Automate browser checks rather than asking the user to test manually. Delegate the
    browser-driving to a subagent on Sonnet (`model: "sonnet"`) instead of running it from the main
    session.

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
