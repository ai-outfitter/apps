import type { Thread } from "@ai-outfitter/app-sdk/threads";
import { z } from "zod";
import { intakeFocus, productsFocus, videosFocus } from "../agent-focus";

export const conversationType = "planning.conversation";
export const projectContext = "planning.project";
export const intakeContext = "planning.intake";
export const videosContext="planning.videos";
export const productsContext = "planning.products";

export function projectConversationScope(thread: Thread) {
  if (thread.type !== conversationType || !thread.context) throw new Response("Not a Planning conversation", { status: 400 });
  if(thread.context.type===videosContext){if(thread.context.id!==videosFocus.id)throw new Response("Invalid video context",{status:400});return {intake:true as const,videos:true as const,projectId:null};}
  if (thread.context.type === productsContext) {
    if (thread.context.id !== productsFocus.id) throw new Response("Invalid products context", { status: 400 });
    return { intake: true as const, products: true as const, projectId: null };
  }
  if (thread.context.type === intakeContext) {
    if (thread.context.id !== intakeFocus.id) throw new Response("Invalid intake context", { status: 400 });
    return { intake: true as const, projectId: null };
  }
  if (thread.context.type !== projectContext) throw new Response("Unknown conversation context", { status: 400 });
  return { intake: false as const, projectId: z.uuid().parse(thread.context.id) };
}
