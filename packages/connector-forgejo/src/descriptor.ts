import { repositoryReadManifestSchema } from "@ai-outfitter/connector-core/repository-read";
import manifest from "../manifest.json";

export const FORGEJO_DESCRIPTOR = repositoryReadManifestSchema.parse(manifest);
export const FORGEJO_REQUIRED_SCOPES = Object.freeze([
  "read:user",
  "read:repository",
  "read:issue",
]);
