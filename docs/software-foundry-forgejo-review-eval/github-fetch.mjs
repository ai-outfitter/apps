const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === "https://api.github.com" ||
      (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token")) {
    const target = new URL(url.pathname + url.search, "http://127.0.0.1:3306");
    return nativeFetch(input instanceof Request ? new Request(target, input) : target, init);
  }
  return nativeFetch(input, init);
};

if (process.env.WORKSPACE_FORGEJO_ORIGIN && process.argv[1]?.endsWith("/workspace/gateway.mjs")) {
  delete process.env.WORKSPACE_FORGEJO_ORIGIN;
  process.env.PATH = `/eval/github-bin:${process.env.PATH}`;
  const reviewers = JSON.parse(process.env.WORKSPACE_REVIEWERS);
  process.env.WORKSPACE_REVIEWERS = JSON.stringify(reviewers.map(reviewer => ({
    ...reviewer, token: "ghp_fixture_reviewer",
  })));
}
if (process.argv[1]?.endsWith("/box-kube.mjs")) {
  delete process.env.OUTFITTER_FORGE;
  delete process.env.OUTFITTER_FORGE_ORIGIN;
}
if (process.argv[1]?.endsWith("/box-platform.ts")) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { writeFileSync } = await import("node:fs");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync("/out/github-public-key.pem", publicKey);
  process.env.BOX_PLATFORM_ENV = JSON.stringify({
    ...JSON.parse(process.env.BOX_PLATFORM_ENV), NODE_OPTIONS: process.env.NODE_OPTIONS,
    GITHUB_APP_ID: "100001", GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_CLIENT_ID: "github-fixture-client", GITHUB_CLIENT_SECRET: "github-fixture-secret",
  });
}
