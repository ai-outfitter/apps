/** App menus read only their own identity. Browser account management is a platform page. */
import { mountPrefix } from "../agent-navigation";
type Account = { id: string; name: string; email: string; active?: boolean };

const initial = (account: Account) =>
  (account.name || account.email).slice(0, 1).toUpperCase() || "O";

function show(footer: HTMLElement, account: Account) {
  footer.dataset.userId = account.id;
  for (const node of footer.querySelectorAll("[data-account-initial]"))
    node.textContent = initial(account);
  for (const node of footer.querySelectorAll("[data-account-name]"))
    node.textContent = account.name || account.email;
  for (const node of footer.querySelectorAll("[data-account-email]"))
    node.textContent = account.email;
  footer.hidden = false;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

async function install(footer: HTMLElement) {
  if (!footer.dataset.accountInstalled) {
    footer.dataset.accountInstalled = "true";
    closeOnNavigate(footer);
  }
  const generation = String(Number(footer.dataset.accountGeneration || 0) + 1);
  footer.dataset.accountGeneration = generation;
  const named = document.querySelector<HTMLMetaElement>(
    'meta[name="outfitter-apps"]',
  )?.content;
  let origin = footer.dataset.platformOrigin || location.origin;
  try {
    if (named) origin = new URL(named).origin;
  } catch {
    /* Keep the current origin. */
  }
  for (const link of footer.querySelectorAll<HTMLAnchorElement>(
    "[data-account-link]",
  ))
    link.href = `${origin}${link.dataset.accountLink}`;

  // Demo builds are read-only fixtures: no API calls, so this branch compiles away there.
  if (import.meta.env.OUTFITTER_APP_MODE !== "demo")
    await load(footer, generation);
}

/** The signed-in member when the page did not render one, then the browser's other accounts. */
async function load(footer: HTMLElement, generation: string) {
  const prefix = mountPrefix(location.pathname);
  if (footer.dataset.providedUser !== "true") {
    // The app's own mount answers whoami for its signed-in member.
    const identity = await json<{ user?: Account }>(`${prefix}/api/whoami`);
    if (
      !footer.isConnected ||
      footer.dataset.accountGeneration !== generation ||
      !identity?.user
    )
      return;
    show(footer, identity.user);
  }
}

/** An app link in the menu swaps the page and keeps the sidebar, so close the menu behind it. */
function closeOnNavigate(footer: HTMLElement) {
  footer.addEventListener("click", (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(".account-app-links a")
    )
      return;
    footer
      .querySelector(".account-toggle")
      ?.setAttribute("aria-expanded", "false");
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
  document.addEventListener("astro:before-swap", () => {
    document
      .querySelectorAll<HTMLElement>("[data-account-footer]")
      .forEach((footer) => {
        footer.dataset.accountGeneration = String(
          Number(footer.dataset.accountGeneration || 0) + 1,
        );
        footer
          .querySelector<HTMLElement>(".account-menu")
          ?.setAttribute("hidden", "");
        footer
          .querySelector<HTMLElement>(".account-toggle")
          ?.setAttribute("aria-expanded", "false");
        // Astro preserves the sidebar, but replaces the rail. Return the managed
        // footer to the kept sidebar before the swap so the next rail can adopt it.
        const sidebar = document.querySelector<HTMLElement>("#sidebar");
        if (sidebar && footer.closest(".personal-rail"))
          sidebar.appendChild(footer);
      });
  });
  document.addEventListener("astro:page-load", run);
}
