import { fileURLToPath } from "node:url";

/** Demo packages use the shared panel with scripted replies and no request transport. */
export function scriptedAgentResolution(mode = process.env.OUTFITTER_APP_MODE) {
  return mode === "demo"
    ? {
        alias: [
          {
            find: /^@ai-outfitter\/ui\/react\/AppAgentSidebar$/,
            replacement: fileURLToPath(
              new URL("./react/ScriptedAppAgentSidebar.tsx", import.meta.url),
            ),
          },
        ],
      }
    : undefined;
}
