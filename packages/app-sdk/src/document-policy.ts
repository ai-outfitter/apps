import { z } from "zod";
const id = z.string().min(1).max(256);
/** Generic revision-bound policy and lifecycle protocol; the host owns dispatch authority. */
export const documentPolicyBinding = z.strictObject({owner:id,documentId:id,revision:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/),action:id,provider:id,config:id});
export const documentPolicyResult = z.strictObject({binding:documentPolicyBinding,decision:z.enum(["allow","deny","require-review","unavailable"]),detail:z.json().optional()});
export const documentLifecycleEvent = z.strictObject({id, binding:documentPolicyBinding.extend({action:z.literal("document.sealed")})});
export type DocumentPolicyBinding = z.infer<typeof documentPolicyBinding>;
export type DocumentPolicyResult = z.infer<typeof documentPolicyResult>;
export type DocumentLifecycleEvent = z.infer<typeof documentLifecycleEvent>;
