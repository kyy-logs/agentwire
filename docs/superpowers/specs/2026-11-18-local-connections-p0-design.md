# Local connection management P0

The user approved the short design in chat and requested exploration, a written plan, and implementation in this session. This extends existing local connection and doctor flows; it does not introduce a broker or remote transport.

## Outcome

- A caller can list saved connections involving its exact native chat, with the global current connection shown separately. Display both endpoints' title, directory and identity, current endpoint observations and task blockers. Never treat Codex history presence as online proof.
- One active connection remains the limit. Switching restores an already identity-paired schema-v2 connection, never guesses a latest session, never upgrades a legacy connection, and never silently replaces another chat's pair.
- Switching is preview/apply: a five-minute review token seals the source, current and target records, bindings and routes. Apply rechecks all of them under connection.lock. The current source must belong to both pairs. Both sides must have no unfinished messages, uncertain delivery, unresolved native work, lifecycle work or quarantined data. Exact target endpoint discovery must pass again.
- Stop only the old/target Bus services, never vendor agents. Recheck persisted work after shutdown. Preserve all histories. Write a transition guard before side effects; an interrupted transition blocks new sends/pair activation/switches and doctor reports inspection required. P0 deliberately does not guess a rollback or automatically replay a partial transition.
- Do not send probes while listing or switching. A restored identity pairing is not a newly observed roundtrip. Restored service is started lazily by the next explicit task.
- Doctor reports independent installation, state-path, active routing/bindings, transition, service and endpoint checks with actionable error codes. Native trust and unobserved roundtrips stay unverified. Default doctor is read-only. `doctor --check-write` explicitly tests an existing install directory using a unique temporary file and removes it; it does not alter configuration or permissions.
- Permission failures request native execution approval rather than changing permissions. Report the exact install root and runtime executable used by this execution.

## Boundaries

Windows / Node >=24 / built-in modules only / filesystem JSON storage. No SQLite, API subscriptions, remote rooms, new daemon, vendor permission changes, automatic task cancellation, third Agent, installation or live connection replacement in this implementation run. Setup preview/apply remains the installation path. Existing pairing codes and legacy manual disconnect continue to work.

## Interfaces

`labus connect list --provider codex|claude` uses the existing native caller resolver.
`labus connect switch --provider <provider> --connection <saved-id>` produces review metadata including operationId and canApply; `--apply --operation <id>` executes exactly that reviewed switch.
`labus doctor [--check-write]` returns checks with status ok/warning/error/unverified, code, summary and nextAction. Operational errors retain their errorCode and add guidance without masking uncertainty.

The Skill uses these commands on behalf of explicit user requests; it presents endpoint names/directories, not protocol IDs, and asks only where a target or switch decision is ambiguous.
