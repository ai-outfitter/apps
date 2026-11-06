import { storageMaintenance } from "@ai-outfitter/app-sdk/storage";

// The platform's daily sweep of expired files; concepts never expire, so it has nothing to do yet.
export const POST = storageMaintenance();
