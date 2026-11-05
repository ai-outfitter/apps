/**
 * Keep full-page chat, and fixed panels sized from the same variables, inside
 * the visible area, including the iOS keyboard.
 */
export function installChatViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  let followLatest = false;
  // The visible height with no keyboard, per width (rotation resets it). iOS
  // shrinks innerHeight with the keyboard, so innerHeight cannot be the reference.
  let width = 0;
  let tallest = 0;

  function showLatest() {
    const shell = document.querySelector<HTMLElement>(".app-shell--chat");
    if (!shell?.querySelector(".composer textarea:focus")) return;
    const messages = shell.querySelector<HTMLElement>(".conversation .messages");
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  function sync() {
    // Pinch zoom must magnify the existing layout, not resize it.
    if (viewport?.scale !== 1) return;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!shell) return;
    shell.style.setProperty("--chat-viewport-height", `${viewport.height}px`);
    shell.style.setProperty("--chat-viewport-top", `${viewport.offsetTop}px`);
    // The keyboard already covers the home-indicator area. Do not reserve it twice.
    if (window.innerWidth !== width) {
      width = window.innerWidth;
      tallest = 0;
    }
    tallest = Math.max(tallest, viewport.height);
    shell.style.setProperty(
      "--chat-viewport-obscured",
      `${Math.max(0, tallest - viewport.height - viewport.offsetTop)}px`,
    );
    if (followLatest) showLatest();
  }

  document.addEventListener("focusin", (event) => {
    if ((event.target as Element).matches(".app-shell--chat .composer textarea")) {
      followLatest = true;
      showLatest();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest(".app-shell--chat .messages")) {
      followLatest = false;
    }
  });
  document.addEventListener("wheel", (event) => {
    if ((event.target as Element).closest(".app-shell--chat .messages")) {
      followLatest = false;
    }
  }, { passive: true });
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  window.addEventListener("pageshow", sync);
  document.addEventListener("astro:after-swap", sync);
  sync();
}
