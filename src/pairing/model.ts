import type {Candidate,Provider} from '../installation/model.ts';
import type {ensureService} from '../installation/service.ts';

export type PairCommand={kind:'issue'}|{kind:'redeem';target:Provider;code:string};
export type PairIntent={
 intentId:string;source:Candidate;nativeInputId:string;command:PairCommand;
 capturedAt:string;expiresAt:string;proofRef:string;
};
export type PairDeps={now?:()=>Date;ensure?:typeof ensureService};
