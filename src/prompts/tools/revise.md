Publish the next version of an open proposal. Any member may revise any open proposal.

- `proposal`: proposal id (`P2`, `p2`, or `2`).
- `base_version`: MUST equal the proposal's current version; a stale base fails and reports the current version — re-read it with `council_view` and rebase.
- `change_summary`: what changed and why.
- Section fields (`title`, `summary`, `solution`, `evidence`, `tradeoffs`, `implementation`): give only the sections you change; omitted sections carry over. At least one section MUST change.
- `addresses`: ids of unresolved challenges against this proposal that the revision answers; they become `addressed` until their challenger resolves them.

A revision clears EVERY acceptance of the proposal; all members must accept the new version again.
