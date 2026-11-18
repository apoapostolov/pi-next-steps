# Changelog

## 1.2.0 - 2026-11-18

- `/ns` can delete stale carried steps without leaving the picker. Ctrl+D on a stale row arms it in red, and a second Ctrl+D deletes it. Shift+Ctrl+D arms every stale row in red, and a second Shift+Ctrl+D deletes all of them. The current reply's rows stay untouched.

## 1.1.6 - 2026-11-18

- Multiple blocks per reply: every `next_steps` call keeps its own options, so
one reply can offer several separate choices.
- Carry-forward works. States are per reply and always cleared, so a block is
queued once instead of being re-queued on every later turn.
- Carried entries show their real age (`1 reply back`, `2 replies back`) and
the list is youngest first.
- `/ns` opens a tabbed picker over every collected block, newest reply first.
Space toggles, arrows move and switch block, enter sends.
- Picked steps retire individually: a block answered during its own reply is
never carried afterwards, and untouched siblings survive.
- `/ns clear` drops stale steps from older replies and keeps the last prompt's.
- `/ns clear X` drops the steps collected in the last X posts.
- Every selection travels as one user message.

## 1.1.5 - 2026-11-16
