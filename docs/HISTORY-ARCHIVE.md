# Historical pairing archives

Explicitly archived, disconnected pairings are omitted from the normal saved-connection list. Inspect all retained history with:

```text
labus connect list --provider codex --include-archived
```

An archive receipt records `tracking_retired_unverified`, the connection record hash, timestamp, and original work counters. Messages, native events, lifecycle results, and failure outcomes stay in their original directories. Archiving does not resolve unknown delivery or mark any task successful. Archived connections cannot be restored through the normal switch path.

The archive operation refuses the current pairing, routed pairings, live target services (including old services without diagnostic metadata), unfinished or uncertain Bus tasks, and changed connection snapshots. Historical native evidence may remain unresolved when the user has explicitly chosen to stop tracking it.

Expired pairing requests that never obtained an identity intent or transport write may have their pending notices explicitly suppressed. This records `suppressed` and `expired_by_user`; it does not mean delivered. Such records remain available for audit and are excluded from routine job pruning.

This maintenance operation is explicit. It is not automatic deletion, task cancellation, or retry of an old pairing request.
