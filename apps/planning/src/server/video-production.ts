export * from "@ai-outfitter/creative-workflow/video-store";
import type { VideoContext as SharedVideoContext } from "@ai-outfitter/creative-workflow/video-store";
import type { PlanningContext } from "./intake";
/** Planning retains its native services alongside the shared media adapter. */
export type VideoContext = PlanningContext & SharedVideoContext;
