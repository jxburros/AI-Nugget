# CLAUDE.md

Follow `AGENTS.md` first.

## Change Process

- Make the smallest safe change that preserves the public contract.
- Update `README.md` when setup, exports, provider support, or user-facing behavior changes.
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
