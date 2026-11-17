# Changelog

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

Implemented in an isolated branch and installed locally with explicit user
authorization for native acceptance; not released. Native pairing is still
unverified. Exact Skill tool-result lineage distinguishes native text companions
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
