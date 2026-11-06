/** Resolve demo builds to the shared scripted sidebar without app/thread transport. */
export function scriptedAgentResolution(mode?: string):
  | {
      alias: { find: RegExp; replacement: string }[];
    }
  | undefined;
