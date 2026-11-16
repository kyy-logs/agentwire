# Changelog

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
