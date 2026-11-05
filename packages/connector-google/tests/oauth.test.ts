import test from "node:test";
import assert from "node:assert/strict";
import { googleIdentity, googleToken } from "../src/index";
test("OAuth rejects redirects and unverified account identities", async () => {
  await assert.rejects(
    () =>
      googleToken(
        { code: "test" },
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.invalid" },
          }),
      ),
    (error: unknown) => error instanceof Response && error.status === 502,
  );
  await assert.rejects(() =>
    googleIdentity("test", async () =>
      Response.json({
        sub: "one",
        email: "one@example.com",
        email_verified: false,
      }),
    ),
  );
});
