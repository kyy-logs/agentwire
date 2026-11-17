import type {Candidate,Provider} from '../installation/model.ts';
import type {ensureService} from '../installation/service.ts';
import type {discoverCandidates} from '../installation/discovery.ts';

export type PairCommand={kind:'issue'}|{kind:'redeem';target:Provider;code:string};
export type PairEvent={hook_event_name:'UserPromptSubmit';session_id:string;turn_id?:string;prompt_id?:string;prompt:string;cwd:string;transcript_path:string};
/** A request ticket is correlation data, never native authority. */
export type PairRequest={requestId:string;provider:Provider;event:PairEvent;observedAt:string;expiresAt:string;intentId?:string};
export type PairIntent={
 intentId:string;source:Candidate;nativeInputId:string;command:PairCommand;
 capturedAt:string;expiresAt:string;proofRef:string;
};
export type PairStep='claimed'|'connection_written'|'bound'|'routes_written'|'active_written'|'connection_paired';
export type PairDeps={now?:()=>Date;ensure?:typeof ensureService;discover?:typeof discoverCandidates;afterStep?:(step:PairStep)=>Promise<void>};
export type PairIssue={invitationId:string;code:string;issuer:Candidate;expiresAt:string};
export type PairActivation={
 activationId:string;invitationId:string;redeemIntentId:string;connectionId:string;
 codex:Candidate;claude:Candidate;phase:'activating'|'paired'|'needs_check';
 createdAt:string;terminalAt?:string;errorCode?:string;
 reuse?:{schemaVersion:1}|{schemaVersion:2;activationId:string};
};
export type Invitation=PairIssue&{
 issueIntentId:string;state:'available'|'revoked'|'claimed';activationId?:string;terminalAt?:string;
};
export type PairState={schemaVersion:1;requests:PairRequest[];intents:PairIntent[];invitations:Invitation[];activations:PairActivation[]};
export type PairTransaction={state:PairState;commit():Promise<void>};
