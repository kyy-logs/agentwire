import {CollaborationStore} from './store.ts';import type {CollaborationController} from './controller.ts';
export async function recoverCollaborationOne(controller:CollaborationController){await controller.store.inspect();await controller.drainOne();}
export async function inspectCollaborationWork(root:string){return new CollaborationStore(root).inspect();}
