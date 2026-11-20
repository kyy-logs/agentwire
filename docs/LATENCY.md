# Local latency P0

## Implemented

- A successful authenticated `accept` / `reply-current` schedules a coalesced drain after the durable commit. `wake` is an authenticated hint with no message body or identity authority.
- Lifecycle Hooks atomically persist events (and terminal clean hints) first, then request a wake. IPC ACK timeout is 150 ms; offline, old, rejecting or unresponsive endpoints do not invalidate persisted events. The default 500 ms poll remains the recovery/retry/evidence fallback. `intervalMs: 0` remains manual mode for deterministic tests.
- There is one drain at a time. A wake received during an active drain requests another pass, rather than starting concurrent adapters. Shutdown still stops new submissions and waits for the in-flight receipt.
- Pairing results commit independently of notification confirmation. Initial notification writes remain serialized outside pairing operations; up to eight inspect-only confirmation jobs may settle concurrently while new pairing jobs proceed. Local admission-lock contention is retried only by the bounded, read-only confirmation lane. The worker retains its active ownership marker and lock until all started notifications settle, including error paths. Notification write checkpoints and inspect-only reconciliation still prevent resends after uncertain writes. A notification failure does not revoke a saved pairing.

## Diagnostics

Task state root: `latency.jsonl`; pairing: `<installRoot>/pairing/latency.jsonl`.

| Stage | Meaning |
| --- | --- |
| admission_committed | Validated IPC request persisted; admissionMs includes waiting for bus serialization and admission checks. A duplicate ID may produce another admission sample without another delivery. |
| submission_settled | An adapter/dispatcher attempt has returned and its receipt is durable. queueAgeMs is creation to attempt start (includes prior retries); submissionMs is local monotonic attempt duration including receipt persistence. Accepted does not prove model completion. |
| automatic_result_committed | An exact registered native result has been saved and converted to an automatic reply. captureMs measures this application step, not model generation or time since native Stop. |
| delivery_confirmed | Native inbound evidence has confirmed a reply. deliveryAgeMs is reply creation to confirmation; it is not UI rendering delay. |
| pair_result_committed | The pairing operation result has been committed; executionMs includes operation locks and activation, excludes later notification settling. |
| pair_notification_settled | The notification callback has returned or failed. notificationMs includes sending, confirmation backoff and cleanup. settled only means the callback returned; read the job's notification.phase for actual delivery proof. |

Only stage, timestamps, task/message/request IDs, fixed state labels and duration allowlists are written. No message bodies, pairing codes, paths or credentials. Stage durations use a monotonic clock; queue/delivery ages use persisted wall timestamps and are omitted if negative. Diagnostics are best effort and stop appending when a file reaches 4 MiB (at most a small concurrent-record overshoot); they never pause business work. Rotate/remove the diagnostic file manually when needed. Ordinary chats are not logged as tasks.

## Limits and verification

This removes avoidable polling and head-of-line waiting. Native agent busy state, approval prompts, native identity evidence availability, model generation and cold process startup can still dominate. No identity, expiry, native delivery or permission checks were removed. No SQLite or new service was introduced.

Regression tests use real local IPC and durable temporary files with fake native adapters: immediate admission, in-flight wake coalescing, offline/unresponsive Hook ACK, lost-wake periodic recovery, delayed notification with late-arriving job, notification failure, diagnostic failure and payload exclusion. These establish scheduling/commit behavior, not real vendor model speed or visible chat latency. Native measurements must use exact original sessions and independently distinguish submission, observed inbound, response end and return confirmation.

### Controlled local sample (2026-11-20)

Six fresh temporary Bus instances per variant, actual authenticated IPC and atomic files, fake native adapters. Baseline uses the HEAD `main.ts` scheduler with a 500 ms poll; other modules use the same working tree. Measure IPC admission start to adapter submit entry after binding. Median: polling **503.565 ms**, immediate wake **24.770 ms**. This is a small local scheduling sample, not a vendor/model benchmark, not cold full-install startup, not UI rendering, and not end-to-end chat latency. It demonstrates removal of the polling wait; the production fallback remains 500 ms.

### Hook startup optimization (2026-11-20)

On Windows, Codex already invokes a Hook through its configured shell. A second PowerShell is unnecessary when Node has a drive-absolute ASCII executable path with no spaces or shell syntax. The installer now emits that callable token and quoted arguments, leaving the configured native shell unchanged. Spaced executable paths, smart double quotes in argument paths, and cmd delayed-expansion bang characters retain the encoded launcher. The existing rejection of double quotes, dollar signs, backticks, percent signs and line breaks in Hook paths remains; this is not universal Windows-path support. Prompt/terminal deadlines remain 15/5 seconds. Changed commands require native trust review.

Ordinary inputs and terminal events capture the exact registered lifecycle event before returning, without importing pairing requests/jobs/worker. Recognized pairing inputs still stage and verify native identity. A worker import/start failure after durable enqueue leaves the exact job queryable as needs_check. Launcher migration rollback restores the predecessor operation's exact owned groups from the verified backup while preserving unrelated edits.

Five interleaved cold child-process samples per case, Node 24.9.0 on this Windows machine: nested PowerShell median **1581.622 ms**, one configured shell **960.630 ms** (same eager router and outer shell); eager router import **322.119 ms**, lazy router import **261.468 ms** (matching isolated runtime copies). These separate comparisons must not be added as an end-to-end gain. No native window performance improvement has yet been established by these measurements. The sole expired P0 input probe was separately removed after an exact-command and expiry check plus backup; no duration is attributed to its removal.

Windows regressions execute the generated command through PowerShell and cmd, including Chinese/spaced argument paths, restricted PATH, child errors, spaced Node fallback, smart quotes and cmd delayed expansion. The cmd harness uses verbatim outer quoting to match the pinned Codex v0.169.1 command runner. Isolated module-denial tests verify durable ordinary lifecycle capture and a queryable worker-start failure without issuing an invitation.

Full validation exposed a Windows atomic-replacement sharing denial (EPERM on pairing job rename). The atomic write helper now retries only that same rename on Windows EPERM/EACCES, at most three retries with 10/20/40 ms waits. It does not recreate a task, re-run a pairing operation, delete the destination, or acknowledge failed writes; permanent errors retain the previous state and remove only the helper's temporary file. Other error codes are not retried.

### Native original-chat sample after Hook trust (2026-11-20)

One task in the explicitly selected original Codex chat and Claude `dell-42`, after all three new Codex Hooks were independently observed as trusted. Exact task completed with the expected arithmetic output and its automatic reply was independently confirmed delivered in the same Codex chat. From durable admission to delivery confirmation: **9.899 s**; to native Codex input record: **9.534 s**. This is one sample, not an average or a controlled before/after experiment.

| Sequential interval | Seconds |
| --- | ---: |
| Durable admission → Claude native input | 0.267 |
| Claude native input → answer record | 1.775 |
| Answer record → automatic result committed | 0.538 |
| Automatic result committed → Codex queue receipt persisted | 0.714 |
| Queue receipt persisted → original Codex turn ended | 4.738 |
| Original turn ended → reply turn started | 0.047 |
| Reply turn started → native input record | 1.455 |
| Native input record → delivery confirmation | 0.365 |

The queue receipt checkpoint follows native queue acceptance; it is not the precise enqueue instant. Native input persistence is not UI-render timing. The 4.738 s interval contains the producer still composing and completing its final answer; it is not evidence-scanning overhead. Compared with a previously inspected different run's approximately 3.90 s startup-to-input interval, this sample's 1.455 s is shorter, but it cannot isolate Hook savings or establish an overall speedup. The measured local-launcher benefit remains the controlled cold-process comparison above. A useful next measurement should end the sending turn with a minimal acknowledgement and retain exact identity, task and native-turn evidence.

### Minimal sender acknowledgement follow-up sample (2026-11-20)

Same original chats and identical arithmetic task text; one fresh, user-authorized task, submitted once. The producer's final answer was shortened to one acknowledgement. Task completed and exact automatic reply was independently confirmed delivered. Admission to delivery confirmation: **8.185 s**, versus the preceding sample's 9.899 s. Queue receipt persisted to producer turn ended: **3.790 s**, versus 4.738 s. Reply-turn start to native input: **1.411 s**, versus 1.455 s.

The 1.714 s total difference is not an isolated effect of shorter output: automatic-result commit to queue receipt also changed from 0.714 s to 0.095 s, and model/runtime stages varied. This is a two-sample observation, not an average or controlled speedup claim. The minimal acknowledgement still left 3.790 s after reply queue receipt, including 1.216 s from producer final-answer persistence to native turn completion. The latter is a measured interval, not proof that all of it belongs to a Hook. No runtime, configuration, permission, or message-state edits were made for this follow-up.

### Exact Hook-boundary breakdown of the minimal-acknowledgement sample

Read-only investigation of the same 8.185 s sample, without another task or configuration change:

| Sequential interval | Milliseconds |
| --- | ---: |
| Reply queue receipt persisted to producer final-answer record | 2574 |
| Producer final-answer record to Stop observedAt | 926 |
| Stop observedAt to native producer turn completion | 290 |
| Native producer completion to reply-turn start | 48 |
| Reply-turn start to input Hook observedAt | 1086 |
| Input Hook observedAt to native input record | 325 |

The first three rows sum to the previously reported 3790 ms producer wait; the last two sum to the 1411 ms reply-start interval. `normalizeHook` assigns `observedAt` after process startup, static imports, stdin parsing and exact route lookup. Neither the 926 ms nor the 1086 ms proves cold-start cost. The 290/325 ms tails include durable capture, best-effort IPC wake, process exit and native bookkeeping, rather than isolated IPC duration. Codex v0.169.1's command runner waits for synchronous child completion; its Windows shell is configurable, defaulting to COMSPEC/cmd when not configured, so an outer PowerShell benchmark does not establish the native launch shell.

Next priority: bounded opt-in stage instrumentation, with monotonic durations for import, routing, durable capture and wake, correlated to the exact native turn and excluding bodies and credentials. If import/launch dominates, compare a lightweight bundled JavaScript entry against the current TypeScript entry. If wake dominates, optimize that measured path only after durable persistence; retain periodic recovery. Preserve result association, atomic writes and native trust. The already-small 48 ms native turn gap and 251 ms delivery-confirmation tail are lower priorities. No projected end-to-end speedup is established by this breakdown.

Native implementation reference: https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/hooks/src/engine/command_runner.rs

### Optional Hook phase timing

Timing is disabled by default. Diagnostic opt-in is a fixed `<installRoot>/hook-timing.json` with schemaVersion=1, exact provider and sessionId, and ISO expiresAt <=24h ahead. Remove the file or let it expire to stop collection. It grants no authority. Invalid, missing, expired, different-session or oversized opt-ins produce no log. Fixed output hook-timing.jsonl stops appending at 1MiB, with a possible small concurrent-record overshoot. No body, output, code, path, token or arbitrary error is copied.

One metadata record contains the native session/execution IDs and monotonic cumulative stages from router module readiness: stdin decoded, diagnostic ready, lifecycle import start/ready, route lookup, normalization, capture persisted, wake start/end, router finished. nodeUptimeAtRouterReadyMs includes Node initialization and initial static imports, not an OS/native dispatch timestamp. router_finished occurs before diagnostic flush and process/native exit. Missing stages remain absent on early errors. Durable lifecycle persistence remains before wake; diagnostic errors cannot alter the business result.

Local sample: five interleaved direct Node children per event and flag with real temporary authenticated IPC, while the offline suite also ran. Input/Stop module-load medians:25.640/25.248ms; route:2.611/2.778ms; capture:9.683/18.437ms; wake:4.950/4.560ms. Parent wall medians disabled/enabled:269.612/290.949ms for input and297.189/305.188ms for Stop. These differences are observations under shared load, not established diagnostic overhead. Separate medians are not additive. This excludes native shell, real agent/model and UI; original-window phase evidence is still required before attributing historical one-second intervals or claiming a speedup.

Cap boundary clarification: one complete record can cross the threshold, as can concurrent in-flight records; subsequent appends stop. This is not a strict byte quota or JSONL truncation. Independent boundary observation:1048575→1048908 bytes, then unchanged. A dedicated near-threshold regression is deferred; the existing capped-output test verifies business capture continues without further diagnostic append.

### Original-chat phase-timing sample with native compaction (2026-11-20)

One fresh user-authorized task, submitted once; exact answer AW-PHASE-TIMING-20261120-R1 5183. Task completed and automatic reply confirmed delivered, each attempts=1. Admission-to-delivery-confirmation119.441s. Exact native ContextCompaction item records110.933s (06:12:09.827Z to06:14:00.760Z) before the reply input record. Do not count this as Bus confirmation or Hook startup, or use this sample as a normal latency benchmark. Removing that interval arithmetically does not predict another run.

Sequential segments in seconds: admission→Claude input0.126; input→answer2.455; answer→automatic commit0.621; commit→Codex queue receipt0.874; queue receipt→producer turn complete3.327; producer complete→reply turn start0.042; reply start→compaction start0.072; compaction110.933; compaction end→native input0.904; input→confirmation0.087.

Exact reply input Hook:Node uptime at router ready88.090ms; router cumulative47.259ms, including lifecycle import18.169ms, capture15.177ms and wake3.083ms. Sender Stop:Node uptime94.192ms; router456.640ms, including normalized-to-capture403.541ms and wake3.889ms. These exclude diagnostic flush/process exit/native dispatch. Stop capture includes durable clean hint, input/message lookups and event persistence; finer stages are needed before attributing403.541ms to storage or choosing a safe optimization. Current evidence makes reducing IPC wake or bundling the18ms module import a lower priority than producer-turn completion, occasional compaction and the composite Stop capture path. No native compaction settings, permissions, association or durable-write semantics were changed.
