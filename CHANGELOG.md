# Changelog

## 1.1.0 — 2026-11-16

- Added `rewriteProseOffers` setting (default off): detects a trailing offer in the last assistant message and registers it as next steps.
- Turn-end hook for prose-offer rewrite.

## 1.0.0 — 2026-11-16

- Initial release.
- `next_steps` tool with options, multi, rec, risky, subtitles, alternates, carry.
- `/ns` and `/nextsteps` commands.
- Settings file support.
- Carry-forward queue, steer on click, alternate groups.
- Auto-classification (best-effort).
- System-prompt guidance.
