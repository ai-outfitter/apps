// The platform's identity routes that every app shell's account menu reads.
// The platform answers them on every app mount, never the app, so the test
// worker answers them as the platform would and page-request checks skip them.

/** The member the platform reports to an app shell under test. */
export const testMember = { id: "test-member", name: "Test member", email: "member@example.test" };

const answers: Record<string, unknown> = {
  "/api/whoami": { user: testMember, organization: null, installation: null },
  "/api/accounts": { accounts: [{ ...testMember, active: true }] },
};

/** Whether `url` (a URL or a path) is one of the platform's identity routes. */
export function isPlatformIdentityRequest(url: string | URL) {
  return new URL(url, "https://app.test").pathname in answers;
}

/** The platform's answer to an identity route, or undefined for any other request. */
export function platformIdentityResponse(method: string, url: string | URL) {
  const answer = answers[new URL(url, "https://app.test").pathname];
  return method === "GET" && answer ? Response.json(answer) : undefined;
}
