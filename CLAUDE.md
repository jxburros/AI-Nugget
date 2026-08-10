# CLAUDE.md

Follow `AGENTS.md` first.

## Change Process

- Make the smallest safe change that preserves the public contract.
- Run every new feature through the Feature Admission Test in `AGENTS.md` before
  building it. If it fails, say so and propose the app-side shape instead.
- Update `README.md` when setup, exports, provider support, or user-facing
  behavior changes; update the matching page under `docs/` when the detail
  belongs there (`providers`, `reliability`, `security`, `agent-loop`,
  `recipes`, `integrations`, `distribution`). Keep `README.md` a front door —
  reference detail lives in `docs/`.
- Update tests when changing transport, parsing, retries, policy, redaction, or agent-loop behavior.
- Do not add provider policy as a library default. Apps configure blocklists or allowlists at the seam.

## Changelog Format

When a changelog is added, use:

```markdown
## YYYY-MM-DD - Claude

### Changed
- ...

### Not completed
- None.

### Notes
- Validation: ...
```
