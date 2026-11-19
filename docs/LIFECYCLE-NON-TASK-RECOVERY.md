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

- The saved schema-2 identity connection is paired, or a schema-1 clean-v1
  connection is ready, and it matches the exact provider and session. Legacy
  wire connections and other connection phases remain ineligible.
- No unfinished/uncertain message or outstanding native task exists, including
  legacy tasks without native attempt IDs.
- There is exactly one event and one complete terminal hint for that execution;
  no output, message ID, nonce, background work, continuation, or conflict exists.
- No native attempt owns that execution; an unresolved write also prevents proof.
- Native session records positively establish human provenance, independently of
  the message wording. Codex requires a composer root with one human-provenance
  text input and one matching completion/abort. A running composer can also
  receive several native human inputs: each must independently prove human
  provenance in the same turn, have one text block, a distinct native message ID,
  strictly increasing finite creation time and the native user.text kind. This
  supports human steering/approval answers without parsing their text. Repeated
  IDs, mixed origins, missing metadata or ambiguous ordering stay unresolved.
  A composer abort with zero input
  is eligible only if no tool activity was recorded, with the bounded desktop
  observation exception below. Claude requires exactly one
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

## Empty desktop page observations

Codex Desktop can insert two intrinsic `function_call_output` records before
any user input is persisted: `agent.codex_apps_open_page` and
`agent.codex_apps_selected_page_part_1_of_1`. For an aborted composer root with
zero input, the verifier accepts this complete pair only for native `vscode`
sessions, in that order, with no other tool activity. Both must have the exact
native field set (no `call_id`), distinct `fco_` IDs, matching turn metadata and
finite ordered creation times. Page ID and document view must both be null.
Unknown fields, nonempty pages, partial/duplicate pairs, real calls, other
outputs, CLI/peer origins and task-owned executions remain unresolved.

All existing event/hint, session/directory, task ownership, duplicate evidence
and stable-snapshot checks still apply. The processor adds the same audited
non-task marker; it does not delete events or retry a failed pairing request.

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

## Empty desktop prelude acceptance (2026-11-19)

The exact empty-page abort shape was reproduced before the fix. Review then
identified two additional refusal cases: new response/tool types and partial
duplicate evidence in a second native file. Four failing regressions confirmed
these cases before the conservative response collection and duplicate accounting
were corrected. The final complete suite passed 456 tests with zero failures,
cancellations or skips; independent source review found no remaining issues.

One runtime verifier file was backed up and replaced. The original Bus was
already offline, with its old PID confirmed exited, so the existing connection's
service was started normally. It automatically added the audited non-task marker
for the original empty-page interrupt; pending artifacts went from one to zero.
All four outstanding-work counters are now zero. Hashes of 92 protected files
were unchanged, including connection identities, routes, native/task history,
pairing jobs, Hook configuration and Skills. No failed redemption was retried.

The final doctor check confirmed the Bus running and the original pair retained.
It separately reported externally changed Claude Hook configuration: the three
AgentWire lifecycle groups were absent. That configuration was preserved by this
runtime-only repair, so this acceptance does not claim restored end-to-end
communication or a new successful pairing.

## Legacy connection and multiple human inputs acceptance (2026-11-19)

A later historical Stop belonged to a native composer turn with three distinct
human inputs (the original request and two approval answers). The selected
connection used schema-1 clean-v1 in ready phase. Both the schema-2-only guard
and single-input assumption prevented proof. Recovery now supports that exact
connection class and independently verifies every additional human input;
legacy wire modes, duplicate inputs and mixed/ambiguous origins still defer.

Four positive regressions failed before the patch, then all 70 focused tests
passed. Independent read-only review found no actionable issues. The full suite
passed 500 tests with zero failures, cancellations or skips.

Exactly one runtime verifier was installed through standard setup, with backup
and manifest verification. The existing Bus closed normally and restarted; it
automatically wrote the original event's audited non-task marker with
inputCount=3. Pending artifacts went from one to zero, with all other work
counters also zero. The same read-only connection-replacement preflight passed.
Hashes of 97 protected original files stayed unchanged, including configuration,
Skills, identities, routes, task history and failed pairing requests. No code
was claimed, redemption replayed, connection replaced or task resent. A new
pairing and current peer availability require their own verification.
