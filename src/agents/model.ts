import type {AgentAdapter,AgentBinding,MessageRecord,ReconcileResult} from '../model.ts';
import type {Candidate,InstallContext,Provider} from '../installation/model.ts';
import type {AppServerClient} from '../native/app-server.ts';
import type {EvidenceReader} from '../native/model.ts';
import type {ReplyCommand} from '../envelope.ts';
export type PairProof={timestamp:string;cwd:string};
/** Informational session observation only; it grants no task authority. */
export type NativeSessionStatus={provider:Provider;sessionId:string;status:'waiting_approval';scope:'session';taskAssociation:'unconfirmed';observedAt:string;updatedAt:string;evidenceRef:string};
export type AgentRuntimeOptions={client:AppServerClient;exe:string;home:string;observe:(binding:AgentBinding,record:MessageRecord)=>Promise<ReconcileResult>;command?:ReplyCommand};
/** Native semantics live in each implementation. No method may infer human authority from peer text. */
export interface AgentIntegration {
 readonly provider:Provider;
 readonly sessionEnv:string;
 readonly allowSkillSession:boolean;
 readonly executionIdField:'turn_id'|'prompt_id';
 readonly transcriptDirectory:string;
 readonly sessionNamedTranscript:boolean;
 acceptsLifecycleAgentType(value:unknown):boolean;
 discover(context:InstallContext,sessionId?:string):Promise<Candidate[]>;
 readSessionStatus?(context:InstallContext,sessionId:string,now:Date):Promise<NativeSessionStatus|undefined>;
 provePairInput(rows:any[],event:any):PairProof|undefined;
 createRuntime(options:AgentRuntimeOptions):Promise<{adapter:AgentAdapter;reader:EvidenceReader}>;
}
