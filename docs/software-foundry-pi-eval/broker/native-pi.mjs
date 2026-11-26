import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const providerId = "openai-codex";
const version = "1.0.4";
const codexEndpoint = "https://chatgpt.com/backend-api/codex/responses";
const localRepos = resolve(import.meta.dirname, "../../../..");

export async function privateDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw Error("An absolute private directory is required");
  const full = resolve(path);
  const canonical = await realpath(full);
  const stat = await lstat(full);
  if (full !== canonical || full === localRepos || full.startsWith(localRepos + sep) ||
    !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)
    throw Error("Use an external owner-only directory, with mode 0700 and no symlink");
  for (let parent = canonical; dirname(parent) !== parent; parent = dirname(parent)) {
    try {
      const git = await lstat(join(parent, ".git"));
      if (git.isDirectory()) await lstat(join(parent, ".git", "HEAD"));
      throw Error("Directory must be outside Git checkouts");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return canonical;
}

async function privateAuthFile(dir) {
  const file = join(dir, "auth.json");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)
    throw Error("Pi auth.json must be an owner-only regular file with mode 0600");
  return file;
}

async function pinned(runtimeDir, name, entry) {
  const root = join(runtimeDir, "node_modules/@earendil-works", name);
  if (await realpath(root) !== root) throw Error("Pi packages must live inside the private runtime");
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (metadata.name !== `@earendil-works/${name}` || metadata.version !== version) throw Error("Install the exact Pi 1.0.4 runtime");
  return import(pathToFileURL(join(root, "dist", entry)).href);
}

/** Credential refresh and conversion use Pi's own provider and credential store.
 * The injected fetch is for synthetic provider tests; the local CLI never swaps it. */
export async function createNativeProvider({ runtimeDir, authDir, model, fetch: transport = globalThis.fetch }) {
  const runtime = await privateDirectory(runtimeDir);
  const directory = await privateDirectory(authDir);
  const file = await privateAuthFile(directory);
  const [{ createModels }, { openaiCodexProvider }, { AuthStorage }] = await Promise.all([
    pinned(runtime, "pi-ai", "models.js"),
    pinned(runtime, "pi-ai", "providers/openai-codex.js"),
    pinned(runtime, "pi-coding-agent", "core/auth-storage.js"),
  ]);
  const native = AuthStorage.create(file);
  const credentials = {
    async read(id, options) {
      if (id !== providerId) return;
      await privateAuthFile(directory);
      const grant = await native.read(id, options);
      if (grant?.type === "oauth") return grant;
    },
    async modify(id, update, options) {
      if (id !== providerId) throw Error("Wrong OAuth provider");
      await privateAuthFile(directory);
      return native.modify(id, async grant => {
        if (grant?.type !== "oauth") throw Error("Native Pi OAuth grant unavailable");
        return update(grant);
      }, options);
    },
  };
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(openaiCodexProvider());
  const selected = models.getModel(providerId, model);
  if (!selected || selected.api !== "openai-codex-responses") throw Error("Choose a model listed by native Pi openai-codex");
  if ((await models.checkAuth(providerId))?.type !== "oauth") throw Error("The account holder must sign in to native Pi first");
  return (context, signal) => models.stream(selected, context, {
    signal, transport: "sse", maxTokens: 4096, maxRetries: 0,
    fetch(url, init) {
      if (String(url) !== codexEndpoint) throw Error("Refusing unexpected native provider URL");
      return transport(url, { ...init, redirect: "error", dispatcher: undefined });
    },
  });
}
