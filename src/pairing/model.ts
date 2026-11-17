import type {Candidate,Provider} from '../installation/model.ts';
import type {ensureService} from '../installation/service.ts';

export type PairCommand={kind:'issue'}|{kind:'redeem';target:Provider;code:string};
export type PairIntent={
 intentId:string;source:Candidate;nativeInputId:string;command:PairCommand;
 capturedAt:string;expiresAt:string;proofRef:string;
};
export type PairDeps={now?:()=>Date;ensure?:typeof ensureService};
export type PairIssue={invitationId:string;code:string;issuer:Candidate;expiresAt:string};
export type PairActivation={
 activationId:string;invitationId:string;redeemIntentId:string;connectionId:string;
 codex:Candidate;claude:Candidate;phase:'activating'|'paired'|'needs_check';
 createdAt:string;terminalAt?:string;errorCode?:string;
};
export type Invitation=PairIssue&{
 issueIntentId:string;state:'available'|'revoked'|'claimed';activationId?:string;terminalAt?:string;
};
export type PairState={schemaVersion:1;intents:PairIntent[];invitations:Invitation[];activations:PairActivation[]};
export type PairTransaction={state:PairState;commit():Promise<void>};
