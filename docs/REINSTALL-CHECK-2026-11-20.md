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

This was a manual recovery of legacy installation state, **not a product fix or proof that the old uninstall path now works**. A future fix needs a regression case covering a missing predecessor Hook group and must preserve fail-closed behavior for genuinely foreign configuration edits. Fresh-install uninstall was not separately exercised in this run.

## Evidence handling

Raw backup configuration, native transcripts, connection IDs, messages and local experiment records remain local and are not included in this repository. The public report deliberately contains only sanitized results. Preserve backups until the operator is satisfied with the new installation.
