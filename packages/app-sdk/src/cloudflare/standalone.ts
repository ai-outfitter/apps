import { env } from "cloudflare:workers";
import { defineMiddleware } from "astro:middleware";
import { migrateAppDatabase } from "../migrations";
import {
  cookie,
  forwardedRequest,
  googleFinish,
  googleStart,
  oauthCookie,
  readCookie,
  returnPath,
  sessionCookie,
  sessionCookieFor,
  type StandaloneAuthConfig,
  type StandaloneSession,
  standaloneAuthConfig,
  standaloneIdentity,
  verify,
} from "../standalone-auth";
import { type StandaloneDatabase, type StandaloneOptions, standaloneHost } from "../standalone-host";
import { standaloneHostKey } from "../workflow-host";

// Standalone mode on Workers (docs/standalone-apps.md). `outfitterApp()`
// registers this ahead of the app middleware when OUTFITTER_STANDALONE=1: it
// migrates the bound D1 database, serves /login and /logout, sends anyone
// signed out to /login, and forwards each request with the member's identity
// headers and a workflow host the app answers itself.

const html = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'",
      ...headers,
    },
  });

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);

function loginPage(options: StandaloneOptions, config: StandaloneAuthConfig, returnTo: string, message?: string) {
  const name = escape(options.name);
  const target = escape(encodeURIComponent(returnTo));
  const google = config.google
    ? `<a class="button" href="/login/google?returnTo=${target}">Continue with Google</a>`
    : "";
  const local = options.dev
    ? `<form method="post" action="/login?returnTo=${target}">
        <label>Name <input name="name" autocomplete="name" required maxlength="120"></label>
        <label>Email <input name="email" type="email" autocomplete="email" required maxlength="254"></label>
        <button type="submit"${google ? ' class="secondary"' : ""}>Sign in for local development</button>
      </form>`
    : "";
  const none = !google && !local ? "<p>Sign-in is not set up. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.</p>" : "";
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in to ${name}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1c1b19;--muted:#6b6760;--line:#dedad3;--accent:#1f5f4a}
@media (prefers-color-scheme:dark){:root{--bg:#151513;--card:#1f1f1c;--text:#eceae5;--muted:#a39f97;--line:#34332f;--accent:#7fc4a8}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:32px}
h1{font-size:1.4rem;margin:0 0 4px}p{color:var(--muted);margin:0 0 24px}.error{color:#b3261e}
form{display:grid;gap:12px}label{display:grid;gap:4px;font-size:.9rem;color:var(--muted)}
input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--text)}
button,.button{font:inherit;display:block;text-align:center;text-decoration:none;padding:10px 12px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--card);cursor:pointer}
.secondary{background:transparent;color:var(--accent)}.button+form{margin-top:16px}
</style></head><body><main><h1>${name}</h1><p>Sign in to continue.</p>${message ? `<p class="error">${escape(message)}</p>` : ""}${google}${local}${none}</main></body></html>`, message ? 403 : 200);
}

function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "private, no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

function d1(database: D1Database): StandaloneDatabase {
  return {
    all: async (sql, params = []) => (await database.prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
    run: async (sql, params = []) => {
      await database.prepare(sql).bind(...params).run();
    },
  };
}

async function signIn(request: Request, options: StandaloneOptions, config: StandaloneAuthConfig, returnTo: string) {
  // The form exists only under `astro dev`: a deployed app signs people in with Google.
  if (!options.dev) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const name = String(form.get("name") ?? "").trim() || email;
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254 || name.length > 120)
    return loginPage(options, config, returnTo, "Enter a name and an email address.");
  return redirect(returnTo, [await sessionCookieFor(request, config.secret, { id: `local:${email}`, email, name })]);
}

async function authRoute(request: Request, options: StandaloneOptions, config: StandaloneAuthConfig) {
  const url = new URL(request.url);
  const returnTo = returnPath(url.searchParams.get("returnTo"));
  if (url.pathname === "/login") {
    if (request.method === "POST") return signIn(request, options, config, returnTo);
    return loginPage(options, config, returnTo);
  }
  if (url.pathname === "/logout") return redirect("/login", [cookie(request, sessionCookie, "", 0)]);
  if (url.pathname === "/login/google" && config.google) return googleStart(request, { ...config, google: config.google });
  if (url.pathname === "/login/google/callback" && config.google) {
    const result = await googleFinish(request, { ...config, google: config.google });
    if ("refused" in result) return loginPage(options, config, "/", result.refused);
    return redirect(result.returnTo, [await sessionCookieFor(request, config.secret, result.member), cookie(request, oauthCookie, "", 0)]);
  }
  return undefined;
}

export function standaloneMiddleware(options: StandaloneOptions) {
  let migrated: Promise<unknown> | undefined;
  return defineMiddleware(async (context, next) => {
    const values = env as unknown as Record<string, unknown> & { DB?: D1Database };
    const config = standaloneAuthConfig(values, options.app, options.dev);
    if (typeof config === "string") return new Response(config, { status: 503 });
    if (!values.DB) return new Response("Standalone mode needs a D1 database bound as DB.", { status: 503 });
    const db = values.DB;
    // Once per isolate; a failure is retried on the next request.
    migrated ??= migrateAppDatabase(
      { query: async (sql) => (await db.prepare(sql).all<Record<string, unknown>>()).results, batch: async (sql) => void (await db.batch(sql.map((statement) => db.prepare(statement)))) },
      options.migrations,
    ).catch((error) => {
      migrated = undefined;
      throw error;
    });
    await migrated;

    const url = new URL(context.request.url);
    if (url.pathname === "/__health") return next();
    const auth = await authRoute(context.request, options, config);
    if (auth) return auth;
    const session = await verify<StandaloneSession>(config.secret, readCookie(context.request, sessionCookie));
    if (!session) {
      if (url.pathname.startsWith("/api/")) return new Response("Unauthorized", { status: 401 });
      return redirect(`/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
    }
    const member = { id: session.id, name: session.name, email: session.email };
    Object.assign(context.locals, {
      [standaloneHostKey]: standaloneHost({
        db: d1(db),
        member,
        workflows: options.workflows,
        inference: {
          baseUrl: String(values.INFERENCE_BASE_URL ?? "") || "https://api.openai.com/v1",
          apiKey: String(values.INFERENCE_API_KEY ?? "") || undefined,
          model: String(values.INFERENCE_MODEL ?? "") || undefined,
          imageModel: String(values.IMAGE_MODEL ?? "") || undefined,
        },
      }),
    });
    return next(forwardedRequest(context.request, standaloneIdentity(config, member)));
  });
}
