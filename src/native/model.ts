import type {ExecutionRef} from '../lifecycle/model.ts';
export type Provider='codex'|'claude';export type WireVersion='legacy'|'clean-v1';
export type SearchAnchor={turnId:string;itemId:string}|{empty:true};
export type DispatchIntent={searchAnchor?:SearchAnchor;schemaVersion:1;connectionId:string;provider:Provider;targetSessionId:string;sourceSessionId:string;messageId:string;attemptId:string;transportId:string;wireVersion:'clean-v1';bodySha256:string;createdAt:string;updatedAt:string;phase:'prepared'|'write_started'|'queued'|'mapped'|'terminal'|'reply_committed'|'delivered'|'needs_check'|'not_written';nativeExecutionId?:string;evidenceRef?:string;errorCode?:string};
export type NativeIdentity={provider:Provider;sessionId:string;nativeExecutionId:string;transportId:string;evidenceRef:string};
export type NativeTerminal={ref:ExecutionRef;nativeOutcome:'response_ended'|'error'|'interrupted';body:string;evidenceRef:string;backgroundPending:boolean;continuation:boolean;incomplete:boolean};
export type Evidence={status:'missing'|'unavailable'|'limit'|'conflict';errorCode?:string}|{status:'delivered';evidenceRef:string;identity?:NativeIdentity}|{status:'mapped';identity:NativeIdentity;terminal?:NativeTerminal};
export interface EvidenceReader{checkpoint?(sessionId:string):Promise<SearchAnchor>;inspect(intent:DispatchIntent):Promise<Evidence>;}

export type CleanTerminalHint=ExecutionRef&{schemaVersion:1;phase:'stop'|'failure'|'interrupt';observedAt:string;backgroundPending?:boolean;continuation?:boolean;incomplete?:boolean;errorCode?:string};
