# Clean reinstall acceptance — 2026-11-20

## Scope and tested source

The requested sequence was: push the current implementation, back up and remove local AgentWire installation traces, install again, and check communication.

The tested product revision is `18dd5fe11f5d5d724d18c6285966795c21f01bde` on `codex/local-connections-p0`. A separate clone from GitHub at that exact revision supplied the installer. This check does not publish a new release archive or update the existing v0.1.1 archive.

## Results

| Check | Observed result |
| --- | --- |
| Offline suite before the product push | 604 passed, 0 failed; Node test runner with test concurrency 1 |
| Backup before cleanup | 2,788 installed files copied and SHA-256 verified after normal Bus shutdown; native configuration, Skills and user PATH backed up separately |
| Local cleanup | Old runtime/state and both installed Skills removed only after verified backup; local development evidence moved to the backup; native chat histories retained |
| Fresh installation | Standard `install.ps1 -Apply` from the independent remote clone exited 0 |
| Installed runtime integrity | All 67 source/assets runtime files matched the cloned source |
| Configuration preservation | Non-AgentWire settings and foreign Hooks matched the pre-cleanup backup; both providers had exactly three AgentWire Hook groups |
| Repeat setup preview | Zero runtime changes and zero configuration changes |
| State isolation | Previous connections, messages and pairing jobs were not copied into the fresh installation |
| New connection | Selected the same exact native Codex and Claude chats; created a new connection with new probe IDs |
| Codex to Claude roundtrip | Native task/result evidence observed; exact answer `667`; automatic reply delivered |
| Claude to Codex roundtrip | Native task/result evidence observed; exact answer `667`; automatic reply delivered |
| Final connection state | `ready`; both `probeChecks` reported `transport: observed`, `answer: expected` |

The fresh install initially used the default manual pairing mode. Previously authorized automatic pairing was then re-enabled with a new generation; old jobs were not replayed. Installed Hook definitions matched the previously configured definitions. File comparison alone is not a claim of native trust; actual lifecycle capture was confirmed by the two roundtrips.

The reverse probe here is the built-in connection probe submitted through the Bus. It proves delivery into the original Codex chat and automatic return into the original Claude chat. It does not independently prove that Claude chose and executed an outbound `ask` tool command after reinstall. New human connection-code issue/redeem, vendor-process restart, and real business-code modification were not repeated in this check.

## Discovered issue: legacy uninstall ownership chain

**The standard uninstall of the old installation did not pass.** It exited with `hook_changed_requires_review`.

Read-only inspection found multiple historical configuration operations whose predecessor snapshots lacked an earlier owned Hook group. Rolling back the newest operation restored such a snapshot and predecessor ownership metadata; the following rollback expected a group that was no longer present and stopped at the safety check. See `src/installation/configuration.ts`, especially the configuration rollback and ownership-chain handling.

For this authorized cleanup, the failed uninstall result and all original state were retained in the verified backup. Cleanup then removed only exact previously registered AgentWire Hook groups, preserved unrelated settings/Hooks, and copied/hash-verified the remaining installed directories before removing them. The clean installation used the normal installer without weakening its checks.

That cleanup was a manual recovery of legacy installation state, **not itself a product fix or proof that the old uninstall path worked**. Fresh-install uninstall was not separately exercised during the original native-window reinstall check.

## Follow-up: bounded legacy-uninstall fix

The subsequent source fix is in `src/installation/configuration.ts`, with ten regression cases in `tests/unit/installation-rollback-omissions.test.ts`.

- `restoredHookSnapshot` accepts a missing predecessor Hook only when one completed successor rollback proves the omission. The before/staged snapshots must match their recorded hashes, and the target must still be owned by that predecessor. It supports existing journals without migrating old state.
- Launcher-generation rollback restores exact predecessor groups from the operation's verified backup, including when the current generation is absent by proven omission.
- Applied targets whose ownership was already released are left untouched. Unregistered interrupted preview directories are skipped; malformed registered operations still fail.
- Same-command modifications, duplicate owned groups, missing proof and damaged snapshots still stop rollback. Foreign settings, Hooks and released Skills are preserved.

Two isolated replays used the verified local backup: the complete 21-operation pre-uninstall history, and its already-interrupted uninstall state. Paths were relocated, credentials redacted, and snapshot hashes recomputed for the isolated fixtures; these are sanitized reproductions, not byte-identical native configuration replays. Both now return exit 0, `phase: uninstalled`, with zero remaining configuration owners. The old source reproduced `hook_changed_requires_review` on the pre-uninstall fixture.

The new regressions also exercise uninstall, repeated uninstall and clean reinstall/uninstall with injected PATH and temporary homes. The current working native installation was not uninstalled again. Original native roundtrip evidence above remains the reinstall check's evidence; these offline checks do not claim a new provider restart or business-code test.

Final offline suite after review: **614 passed, 0 failed, 0 skipped**, using Node's test runner with concurrency 1. The review's additional interrupted-preview case was reproduced failing before its bounded fix.

The fix was installed locally through the standard runtime setup functions after checking zero unfinished, uncertain, native-outstanding or pending-artifact work. A staging source retained the fresh remote installation's unchanged bytes to avoid unrelated CRLF rewrites. Exactly one runtime file changed; the manifest and old file were backed up. Native Hook/Skill configuration, routes, active pointer and connection record hashes remained unchanged, the same connection was preserved, and the Bus resumed running. No new native chat probe was submitted for this uninstall-only update. The development branch contains the fix; no release archive or tag was changed.

## Evidence handling

Raw backup configuration, native transcripts, connection IDs, messages and local experiment records remain local and are not included in this repository. The public report deliberately contains only sanitized results. Preserve backups until the operator is satisfied with the new installation.
