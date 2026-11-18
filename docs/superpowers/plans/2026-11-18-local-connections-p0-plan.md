# Local Connections P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make local saved connections visible, safely switch an idle pair, and diagnose failures in the actual caller environment.
**Architecture:** Reuse connection.json histories, connection.lock, native discovery and JSON state. Add a focused management module and structured doctor. Preview seals state; apply stops Bus services and revalidates before replacing routes. A durable transition guard makes interruptions fail closed.
**Tech Stack:** Node >=24, TypeScript strip-types, node:test, built-in filesystem/crypto modules.
**Spec:** docs/superpowers/specs/2026-11-18-local-connections-p0-design.md

## Global Constraints

- One active local pair; no SQLite, remote transport, API calls, new dependencies or vendor permission changes.
- Exact native session/directory identity; no latest-chat fallback, probes or implicit legacy upgrades.
- No automatic cancellation, replay or archive; preserve task and connection history.
- Existing installation and running connections remain unchanged in this run; verification uses temporary user/state directories.
- Native trust and roundtrip evidence are distinct from disk installation and identity pairing.

## Review Focus

- New task accepted after preview: apply must recheck and refuse without route changes (Task 2).
- Expired/stale preview and foreign caller: never activate a different pair (Task 2).
- Shutdown uncertain or crash between writes: guard survives; new sends fail closed (Task 2).
- Missing/corrupt saved data and changed bindings/routes: report uncertainty, not an empty safe queue (Tasks 1/2/3).
- Redirected environment and denied writes: expose actual paths and a native approval action; do not change settings (Task 3).

### Task 1: Saved connection inspection

**Files:** Create src/installation/connection-management.ts; tests/integration/connection-management.test.ts.
**Interfaces:** Consumes readConnection, FileMessageStore.get, native discovery. Produces listConnections(c,source,deps), inspectConnectionWork(c,id). Work returns unfinished, uncertain, nativeOutstanding, artifactsPending counts. Missing storage is empty only where legitimately optional; malformed/quarantined data blocks switching.

- [x] Write tests for two saved pairs sharing a caller, unrelated-pair filtering, exact endpoint availability, unfinished/unknown/stopped-native work, corrupt records and read-only listing.
- [x] Run `node --experimental-strip-types --test tests/integration/connection-management.test.ts`; expected new behavior fails.
- [x] Implement read-only bounded directory inspection, work blockers and saved-pair views. Reuse existing record validators; no calls to store.list() that mkdir during read.
- [x] Run the same test; expect pass. Commit `feat: inspect saved local connections and task blockers`.

### Task 2: Reviewed safe switch

**Files:** Modify connection-management.ts, connections.ts, paths.ts; integration tests from Task 1.
**Interfaces:** Consumes Task 1 work inspection. Produces previewConnectionSwitch(c,source,id,deps) and applyConnectionSwitch(c,source,id,operationId,deps); guard in paths.ts is enforced by active connection consumers. Switching dependencies allow controlled Bus shutdown and fault injection, never skipping real disk validation.

- [x] Add RED tests: restore a saved schema-v2 pair in both directions; preserve IDs/history and no probe; refuse unknown/unfinished/native work on either side; reject legacy target/foreign caller/stale or expired preview/route and binding changes.
- [x] Add RED tests: task arriving after preview or during shutdown blocks apply; shutdown failure and interrupted writes retain guard and block ask/pair activation; concurrent switching cannot share the lock.
- [x] Implement five-minute preview records, shared lock, exact discovery/bindings/routes, Bus-only shutdown, post-shutdown revalidation, journal/guard and atomic per-file writes. Keep service startup lazy. Serialize legacy ask/followup admission with switching.
- [x] Run management and existing connection/pair recovery tests; expect pass. Commit `feat: safely switch reviewed idle local connections`.

### Task 3: Actionable diagnosis

**Files:** Create src/installation/doctor.ts and guidance.ts; tests/unit/installation-doctor.test.ts. Modify labus.ts and pairing/cli.ts only at integration boundaries in Task 4.
**Interfaces:** Produces diagnoseInstallation(c,{env,checkWrite,connectionDeps}) with independent checks and paths; errorGuidance(code) with summary/nextAction. Consumes inspection from Task 1 and transition guard from Task 2.

- [x] Write RED tests for missing installation, partial setup, pin mismatch, live vs absent service, transition guard, changed bindings/routes, exact-path reporting, and explicit write probe cleanup/denied writes. Unknown native trust is never upgraded.
- [x] Implement independent checks that keep reporting after one fails. `--check-write` probes only an existing safe directory; default diagnostics do not write. Return structured safe error guidance for identity/activation/storage/active connection/task blockers.
- [x] Run doctor tests; expect pass. Commit `feat: explain local connection and execution environment failures`.

### Task 4: CLI, user entry and verification

**Files:** Modify src/labus.ts, src/pairing/cli.ts, both assets/skills/*/labus/SKILL.md, README.md; add tests/integration/connection-management-cli.test.ts and docs/LOCAL-CONNECTIONS-P0.md.
**Interfaces:** CLI commands exactly match spec; old commands and return codes remain compatible. Skill presents review before apply and never guesses a saved target.

- [x] Write RED CLI tests covering native caller resolution, list/switch preview/apply, stale operation, doctor --check-write, unexpected flags and specific error guidance.
- [x] Wire CLI commands and guidance. Update user documentation and both Skill templates for native local list/safe-switch/doctor; do not change installed user copies.
- [x] Run targeted tests, then `npm test` with output saved under evidence/local-connections-p0. Expect exit 0 and all tests passing; no paid model calls.
- [x] Review whole diff independently, fix material findings with RED/GREEN tests, rerun full suite for any fix. Record implementation and untested live boundaries in docs. Commit `feat: expose local connection management and diagnostic commands`.

## Execution

User explicitly requested plan followed by implementation in this session. Use the existing clean linked worktree based on 13a618e and a codex/ branch. The user-facing short design above is the approved scope; no new architecture or configuration approval is requested. Follow tasks inline; one final fresh reviewer as required by executing-plans. No publish/push or installed runtime replacement is implied.
