import test from "node:test";
import assert from "node:assert/strict";
import { googleJson, grantedProviders, scopesForProviders, WRITE_SCOPE_NEEDED, writeGranted } from "../src/index";

test("a connect asks for read and write scopes; reading alone still connects, writing needs its scope", () => {
  assert.deepEqual(scopesForProviders(["gmail", "google-calendar"]), [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ]);
  const readOnly = ["openid", "https://www.googleapis.com/auth/gmail.readonly"];
  assert.deepEqual(grantedProviders(readOnly, ["gmail", "google-calendar"]), ["gmail"]);
  assert.equal(writeGranted(readOnly, "gmail"), false);
  assert.equal(writeGranted([...readOnly, "https://www.googleapis.com/auth/gmail.compose"], "gmail"), true);
  // A write scope without its read scope connects nothing: the app cannot read with it.
  assert.deepEqual(grantedProviders(["https://www.googleapis.com/auth/calendar.events"], ["google-calendar"]), []);
});

test("Google's insufficient-scope 403 is the write-scope signal; other 403s are provider failures", async () => {
  const denied = (reason: string) => async () =>
    Response.json({ error: { code: 403, message: "Insufficient Permission", errors: [{ reason }] } }, { status: 403 });
  const outcome = (reason: string) =>
    googleJson("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { method: "POST" }, denied(reason)).then(
      () => null,
      (error: unknown) => error,
    );
  const refused = await outcome("insufficientPermissions");
  assert.ok(refused instanceof Response && refused.status === 403);
  assert.equal(await refused.text(), WRITE_SCOPE_NEEDED);
  const failed = await outcome("rateLimitExceeded");
  assert.ok(failed instanceof Response && failed.status === 502);
});
