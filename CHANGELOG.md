# Changelog

## Unreleased — Agent integrations and local usability (2026-11-20)

- Centralize built-in discovery, native identity policies, pairing proof,
  lifecycle metadata, and Adapter/EvidenceReader assembly in `src/agents/`.
  Existing Codex/Claude storage and permission boundaries remain unchanged;
  this is not arbitrary third-agent support.
- Add evidence-based task waiting explanations and separate pairing outcomes
  from notification delivery. Keep uncertain writes paused without replay.
- Retain explicit historical tracking archives, native lifecycle recovery,
  bounded wake scheduling, and payload-free timing diagnostics.
- Reduce Windows Hook startup overhead with a safe direct-Node launcher and
  lazy pairing imports, keeping encoded fallback for unsupported paths.
- Keep local acceptance artifacts out of source control.

Original-window adapter regression on 2026-11-20 verified both built-in
transport probes and a forward same-task followup (375 to 376), including exact
native executions and delivered replies. The user additionally reported their
remaining real-use checks complete; those are user-reported rather than a new
independent recording. Installation and clean-reinstall evidence is tracked
separately. Development branch only; the existing v0.1.1 release is unchanged.

## Unreleased — local connections and recovery

- Add saved-connection listing, reviewed idle switching and independent read-only
  diagnostic checks. Keep exact native identities and a durable transition guard.
- Recognize proven pairing/switch control Stops without fabricating inputs or
  capturing ordinary conversation. Preserve failures and ambiguous task ownership.
- Allow explicit reconciliation of attempted expired information replies when exact
  native delivery evidence exists; never replay them or revive expired tasks.
- Guard disconnect admission, confirm shutdown and recheck work before removing
  routes. Preserve state when shutdown or native delivery remains uncertain.
- Add a guarded Codex queue pump that starts only an existing exact queue head on
  the same client's loaded, idle thread. An independent stdio history reader does
  not establish Desktop ownership; real Desktop queue/start remains unverified.

Full Windows offline suite: 324 passed, zero failed/skipped. Original-chat history
restore and a new forward round trip passed; reverse communication was verified
separately before restoration. Different-pair migration was not retested. See
[native acceptance](docs/LOCAL-CONNECTIONS-P0-LIVE-ACCEPTANCE.md) and
[repair details](docs/LOCAL-CONNECTIONS-P0-REPAIR.md). Source development branch
only; no new release archive or tag.

## Unreleased — one-time chat pairing

- Stage explicit pairing requests in native Hook context, then verify the exact
  persisted human input when the client consumes its ticket. A ticket alone is
  not authorization; ordinary chat does not create a pairing record.
- Add bounded JSON invitations, one-time claims and recoverable exact connection
  activation. No SQLite, additional daemon, model API or automatic pairing probes.
- Keep legacy connection admission; identity-paired connections allow an explicit
  first task. Report identity, endpoint detection and actual round trips separately.
- Add symmetric `labus pair issue/redeem/status`, chat Skills and read-only disk
  diagnosis. Native trust/loading remains unverified by disk inspection alone.
- Return an exact cross-provider redeem prompt with issued codes; keep an archived
  connection disconnected in status/doctor even when its service is offline.
- Give newly issued one-time codes a one-hour lifetime; retain existing deadlines
  and the two-minute freshness requirement for first-use native requests.
- Pin the installed launcher's state root despite sandbox-redirection of
  LOCALAPPDATA. Preserve native execution approval for writes outside a project.
- Report EPERM/EACCES as pairing_storage_access_denied instead of an ambiguous
  activation error; native Codex pairing context explains the approval path.

Implemented in an isolated branch and installed locally with explicit user
authorization for native acceptance; not packaged as a release. On 2026-11-18,
new Codex and Claude main chats in different directories completed code pairing
and one observed Codex-to-Claude task round trip. The reverse direction on this
new pair remains untested. Full offline suite: 264 passed, zero failed/skipped.
Exact Skill tool-result lineage distinguishes native text companions
from human pairing inputs without trusting their contents. See
[pairing acceptance](docs/PAIRING-ACCEPTANCE.md) for offline and native boundaries.

## 0.1.1 — 2026-11-16

- Fix a real Windows installation failure: the PATH setter could persist its value but exceed the five-second process timeout before ownership was recorded.
- Confirm the persisted user PATH after both install and rollback writes. A timed-out setter is accepted only when a fresh read exactly matches the desired value; missing or conflicting writes still fail.
- Add four regression cases for committed timeouts, uncommitted timeouts, conflicting values, and a successful setter that did not persist the desired value.
- Full local offline regression: 184/184. Native chat compatibility remains the same as 0.1.0.

## 0.1.0 — 2026-11-16

First AgentWire Windows preview, based on the locally validated clean-v1-r4 implementation.

- Connect explicitly selected, already-running Codex Desktop and Claude Code chats.
- Delegate tasks and followups in both directions using installed Skills.
- Collect final responses through native lifecycle events and exact execution identity.
- Keep protocol IDs out of everyday chat messages; preserve manual/legacy compatibility.
- Persist messages, delivery state and result artifacts in local JSON files.
- Pause uncertain delivery, bound retries and task-family execution budgets.
- Preview installation, merge owned Hooks, support native trust and reversible configuration.
- Include source, unit/integration tests and a Windows install archive.

The initial release retains the `labus` command, Skill names and `LocalAgentBus` data directory for compatibility. It does not change the currently installed local connection when building or downloading this source.
