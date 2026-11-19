# Pairing startup interruption

Automatic pairing first saves a request tied to the original native input. This
is not a verified identity, a consumed invitation, or a successful connection.

On Windows, starting a worker from a native Hook includes a short native helper
and its PID/permit handshake. If the Hook process is terminated before the helper
returns, a JavaScript catch/finally block cannot run. Increasing the timeout in a
file alone does not prove that the original native chat uses the new definition.

## Bounded recovery

The Hook saves its startup owner PID and timestamp in the same atomic job write
as admission. An existing Bus independently checks these records. A dead startup
owner, no live worker, no committed identity proof, and an authorized unstarted
job allow it to record pairing_worker_start_requires_check. The monitor skips
a busy execution lock rather than delaying a replacement that may be waiting
for the same Bus to shut down. The monitor never
starts a worker, verifies an input, consumes a code, sends a notification, retries
a failed request, or changes a connection. It also runs when business processing
is paused; its own errors are logged separately.

Without a running Bus, doctor and pair result expose the same effective failure
read-only. Applying, completed, proven, live-worker and live-owner records are
preserved. Manual mode, prior automation generations, and legacy jobs without a
startup record are not treated as newly abandoned starts. Legacy expired requests
retain the existing read-only expiry behavior; history is not migrated.

Native trust remains a separate boundary. Codex can parse a timeout of 15 seconds
while reporting the changed definition as modified. Review that exact command in
Codex Hooks settings; AgentWire does not edit trusted hashes or click approval.
A fresh process listing is evidence about current disk configuration, not proof
of a running chat reloading it. Never replay an expired pairing request to test a
reload. Use fresh genuine human input after the native review when ready.

This is interrupted-start detection, not a guarantee of process supervision.
An unrelated process reusing a PID can defer detection. If the Bus is offline,
recovery is observable through a read-only query rather than an automatic notice.
A startup record is correlation metadata and grants no pairing authority.

## Verification

The regression suite tests actual child-Hook exit, independent Bus detection,
read-only queries, and preservation of live, proven, applying, manual, legacy,
and prior-generation jobs. It also checks that admission includes startup
ownership in its first durable record. Original-window native acceptance is a
separate gate; isolated tests do not establish a new connection.

## Bounded Windows verification (2026-11-19)

The final offline suite passed 434 tests with zero failures, cancellations or
skips. After an exact seven-file runtime update, 406 protected configuration,
identity and history files retained their hashes. The existing Bus restarted
normally with no outstanding task or lifecycle work.

An isolated installed-module check terminated its own Hook child during launch
and observed the independent startup-failure record without changing pairing
core state or sending messages. A separate owned Windows Job with a deliberate
four-second pre-launch delay completed its fake worker within the configured
fifteen-second budget, with no launcher/start-lock residue. Neither check
redeemed a real invitation or simulated human provenance.

After the user's native review, fresh read-only Codex hook metadata reported
fifteen seconds and trusted for the input Hook. This proves the current parsed
definition, not a successful new original-window pairing. The prior expired
request was retained and not replayed; a new genuine input remains necessary
for that acceptance gate.
