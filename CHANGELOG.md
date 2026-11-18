# Changelog

## 1.1.7 - 2026-11-18

- Carry-forward actually works. States are per reply and always cleared, so a
block is queued once instead of being re-queued on every later turn.
- Carried entries show their real age (`1 reply back`, `2 replies back`) and
the list is youngest first, matching the queue order.
- `/ns` opens a tabbed picker over every collected block, newest reply first,
instead of asking you to type indices. Space toggles, arrows move and switch
block, enter sends.
- Picked steps are retired from the queue, and a block answered in its own
reply is never queued afterwards.
- Every selection still travels as one user message.

## 1.1.5 — 2026-11-16

- Interactive multi-select: next_steps now renders a picker (space toggle,
enter/tab confirm) instead of requiring /ns.
- Recommended and risky tags shown as star RECOMMENDED / triangle RISKY at the
end of each option.
- Risky warning symbol changed from emoji to glyph.
