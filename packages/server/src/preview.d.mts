export type PreviewWorker = {
  fetch(request: Request, env?: unknown, context?: unknown): Promise<Response> | Response;
};
/** App-owned preview behavior, from the module named by `app.json` `preview.policy`.
 * Providing one lets internal previews switch between fixtures and the operational platform. */
export type PreviewPolicy = {
  select: (request: Request, platform: PreviewWorker, env: unknown, context: unknown) => Promise<string>;
  switch: (request: Request) => Promise<Response>;
  /** Platform paths served in operational mode. */
  platformPath: (path: string, method: string) => boolean;
  /** Decorate the app's response; non-HTML responses should pass through. */
  decorate: (response: Response, mode: string, platformOrigin?: string) => Promise<Response>;
};
export function appPreview(
  platform: PreviewWorker,
  app: PreviewWorker,
  template: string,
  revision: string,
  platformAssets: string[],
  platformOrigin?: string,
  policy?: PreviewPolicy,
): { fetch(request: Request, env?: unknown, context?: unknown): Promise<Response> };
