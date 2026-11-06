/**
 * The shared account menu (AccountMenu.astro). It shows the signed-in account
 * (from `/api/whoami` under the app's own mount when the page did not render
 * it) and the browser's other signed-in accounts from the platform's
 * `GET /api/accounts`. Each choice posts the user id to the platform's
 * `/accounts/switch`. Names, emails and user ids only, never a session token.
 *
 * whoami is read under the page's mount (mountPrefix): a personal `/apps/<id>/`
 * page has no browser adapter and its CSP allows only its own path. The
 * platform's routes are absolute same-origin URLs, which a mounted app's
 * browser adapter leaves alone.
 */
import { mountPrefix } from "../agent-navigation";
type Account = { id: string; name: string; email: string; active?: boolean };

const initial = (account: Account) => (account.name || account.email).slice(0, 1).toUpperCase() || "O";

function option(origin: string, account: Account) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = `${origin}/accounts/switch`;
  form.setAttribute("data-astro-reload", "");
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "userId";
  input.value = account.id;
  const button = document.createElement("button");
  button.className = "account-option";
  button.setAttribute("aria-label", `Switch to ${account.email}`);
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = initial(account);
  const label = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = account.name || account.email;
  const email = document.createElement("small");
  email.textContent = account.email;
  // appendChild: the root typecheck also sees the Workers types' Element.append.
  label.appendChild(name);
  label.appendChild(email);
  button.appendChild(avatar);
  button.appendChild(label);
  form.appendChild(input);
  form.appendChild(button);
  return form;
}

function show(footer: HTMLElement, account: Account) {
  footer.dataset.userId = account.id;
  for (const node of footer.querySelectorAll("[data-account-initial]")) node.textContent = initial(account);
  for (const node of footer.querySelectorAll("[data-account-name]")) node.textContent = account.name || account.email;
  for (const node of footer.querySelectorAll("[data-account-email]")) node.textContent = account.email;
  footer.hidden = false;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

async function install(footer: HTMLElement) {
  if (footer.dataset.accountInstalled) return;
  footer.dataset.accountInstalled = "true";
  closeOnNavigate(footer);
  const origin = footer.dataset.platformOrigin || location.origin;
  for (const form of footer.querySelectorAll<HTMLFormElement>("[data-account-route]")) form.action = `${origin}${form.dataset.accountRoute}`;
  for (const link of footer.querySelectorAll<HTMLAnchorElement>("[data-account-link]")) link.href = `${origin}${link.dataset.accountLink}`;

  // Demo builds are read-only fixtures: no API calls, so this branch compiles away there.
  if (import.meta.env.OUTFITTER_APP_MODE !== "demo") await load(footer, origin);
}

/** The signed-in member when the page did not render one, then the browser's other accounts. */
async function load(footer: HTMLElement, origin: string) {
  const prefix = mountPrefix(location.pathname);
  let userId = footer.dataset.userId;
  if (!userId) {
    // The app's own mount answers whoami for its signed-in member.
    const identity = await json<{ user?: Account }>(`${prefix}/api/whoami`);
    if (!identity?.user) return;
    show(footer, identity.user);
    userId = identity.user.id;
  }
  const holder = footer.querySelector<HTMLElement>("[data-account-choices]");
  // A personal /apps/<id>/ page's CSP allows only its own path, so it cannot list the platform's accounts.
  if (footer.dataset.accounts === "false" || prefix.startsWith("/apps/")) return;
  const listed = await json<{ accounts: Account[] }>(`${origin}/api/accounts`);
  if (!holder) return;
  // A host that cannot switch accounts, or a delayed answer for another account, lists none.
  if (!listed?.accounts?.some((account) => account.active && account.id === userId)) {
    holder.replaceChildren();
    return;
  }
  holder.replaceChildren(...listed.accounts.filter((account) => !account.active).map((account) => option(origin, account)));
  const add = footer.querySelector<HTMLElement>("[data-account-add]");
  if (add) add.hidden = false;
}

/** An app link in the menu swaps the page and keeps the sidebar, so close the menu behind it. */
function closeOnNavigate(footer: HTMLElement) {
  footer.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".account-app-links a")) return;
    footer.querySelector(".account-toggle")?.setAttribute("aria-expanded", "false");
    const menu = footer.querySelector<HTMLElement>(".account-menu");
    if (menu) menu.hidden = true;
  });
}

export function installAccountMenu() {
  const run = () => {
    const footer = document.querySelector<HTMLElement>("[data-account-footer]");
    if (footer) void install(footer);
  };
  run();
  document.addEventListener("astro:page-load", run);
}
