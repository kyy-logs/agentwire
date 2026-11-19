# Recovering orphan lifecycle events

A terminal Hook can outlive a missing input Hook, for example after a Hook
timeout, during route activation, or when a composer turn is interrupted before
its input is persisted. An unassociated terminal remains pending by default and
blocks switching connections. This is a history guard, not proof of corruption.

`hook-router.ts` now writes an existing route's lifecycle event before staging
and launching automatic pairing. A capture failure stops that request before
pairing admission. A new chat without a route can still stage pairing normally.
The original route is captured once; a worker replacing it does not redirect or
duplicate that input into the new connection.

For historical terminal events without input, the normal lifecycle processor
can record `verified_native_non_task` only when all of these hold:

- The saved schema-2 connection matches the exact provider and session.
- No unfinished/uncertain message or outstanding native task exists, including
  legacy tasks without native attempt IDs.
- There is exactly one event and one complete terminal hint for that execution;
  no output, message ID, nonce, background work, continuation, or conflict exists.
- No native attempt owns that execution; an unresolved write also prevents proof.
- Native session records positively establish human provenance, independently of
  the message wording. Codex requires a composer root with one human-provenance
  text input and one matching completion/abort. A composer abort with zero input
  is eligible only if no tool activity was recorded. Claude requires exactly one
  human root, matching prompt/session/directory and no sidechain/agent origin.
- Evidence is unique across all exact-session files in a complete, bounded
  enumeration. Duplicate, malformed, incomplete, changing, unsupported or
  oversized evidence fails closed. Native failure events remain unresolved.

The applied marker contains the reason, exact native evidence reference,
snapshot hash, input count and native outcome. Original events/transcripts stay
unchanged. No task binding, captured output, task result, reply, code redemption
or retry is created. This classification does not assert business success.

Bounds: 20,000 directory entries, depth 6, 128 exact-session native files,
256 MiB of native data per scan and 16 MiB per line. Reads use a streaming stable
snapshot. Proofs for existing pending events share a scan; failed scans are
throttled for five seconds. These are recovery limits, not permission changes.

`labus doctor` reports `connectionWork.pendingLifecycleEvents` and a concrete
pending-event count. Unknown or damaged history still blocks switching. Keep
original failed pairing results; resolving their terminal Hook does not retry
the failed pairing request or establish a new connection.

Regression coverage lives in `tests/integration/native-non-task.test.ts`,
`tests/integration/pairing-worker.test.ts`, and
`tests/unit/installation-doctor.test.ts`. Live recovery of a particular local
history must be verified separately from these isolated tests.

## Bounded Windows acceptance (2026-11-19)

After installing the seven changed runtime files and normally restarting the
existing Bus, three historical events were resolved by the program: a human
question's Stop, an empty composer turn's interrupt, and a failed human pairing
request's Stop. Pending artifacts went from three to zero. Hashes of 378 protected
files stayed unchanged, including original events, task records, pairing jobs,
configuration, Skills, identities and routes. Only the non-task applied markers
were added; the existing connection remained selected. No failed redemption was
retried and no new connection/roundtrip was claimed.

The first immediate installation check ran before background reconciliation had
settled and observed a missing marker. Subsequent read-only verification confirmed
all three exact markers and zero outstanding work, without reinstalling or
manually marking history. Acceptance must observe this settlement rather than
assume every native snapshot is stable at the instant health becomes available.

Final offline suite: 419 tests passed, zero failures/cancellations/skips. The
fresh source review's stale-proof cache finding was reproduced in two failing
tests and fixed before this final run. These results cover the stated recovery
scope, not every native CLI version or a fresh target pairing.
