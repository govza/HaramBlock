# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

## Before exploring, read these

- **`docs/INDEX.md`** — the documentation entry point; it maps topics to the right doc.
- **Domain vocabulary** lives inside the subsystem docs, not in a standalone glossary:
  - media terms (Verdict, Prediction, Fail-closed, …) in `docs/MEDIA_PROCESSING.md`
  - video terms (VideoSession, DVR, …) in `docs/VIDEO_PROCESSING.md`
- **`CONTEXT.md`** at the repo root and **`docs/adr/`**, if they exist — read ADRs that touch the
  area you're about to work in.

If `CONTEXT.md` or `docs/adr/` don't exist, **proceed silently** — the subsystem docs above are the
domain source of truth. Don't flag their absence; don't suggest creating them upfront. The
`/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`)
creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo. Domain documentation lives in `docs/`, indexed by `docs/INDEX.md`:

```
/
├── CONTEXT.md                  ← lazily created; a thin glossary that links into docs/, never a rewrite of it
├── docs/
│   ├── INDEX.md                ← entry point
│   ├── MEDIA_PROCESSING.md     ← media vocabulary + content-script architecture
│   ├── VIDEO_PROCESSING.md     ← video vocabulary + video filtering
│   ├── …                       ← other subsystem docs (see INDEX.md)
│   └── adr/                    ← lazily created; architectural decision records
└── entrypoints/ …
```

When `/domain-modeling` resolves a **term**, prefer adding it to the relevant subsystem doc (or
`CONTEXT.md` as a pointer into one) rather than duplicating definitions. When it records a
**decision**, write an ADR under `docs/adr/`.

## Use the documented vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as defined in the subsystem docs above. Don't drift to synonyms the docs
explicitly avoid.

If the concept you need isn't documented yet, that's a signal — either you're inventing language the
project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR or a documented architecture decision in the subsystem
docs, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
