/**
 * The playground scripts' one JSON client: a fixed origin, a bearer token,
 * manual redirects and a timeout. Errors name the method and path but never
 * echo a response body, which may carry provider details.
 * @param {{ origin: string, token: string | undefined, missing: string, label: string, headers?: Record<string, string>, timeout?: number, request?: typeof fetch }} options
 */
export function jsonClient({ origin, token, missing, label, headers = {}, timeout = 20000, request = fetch }) {
  if (!token) throw Error(missing);
  const expected = new URL(origin).origin;
  return async (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body) => {
    const url = new URL(path, origin);
    if (url.origin !== expected) throw Error(`Unexpected ${label} host`);
    let response;
    try {
      response = await request(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw Error(`${label} ${method} ${url.pathname}: response unavailable; inspect recorded state before retrying`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`${label} ${method} ${url.pathname}: HTTP ${response.status}; no alternate credentials or execution path will be used`);
    }
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw Error(`Invalid ${label} response; inspect recorded state before retrying`);
    }
  };
}
