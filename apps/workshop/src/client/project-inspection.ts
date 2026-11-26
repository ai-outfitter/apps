export function projectInspection(host: HTMLElement, onOpen: (name: string) => void) {
 const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
 function open(name: string) {
  if (!tabs.some(tab => tab.id === "tab-" + name && !tab.hidden)) name = "description";
  for (const tab of tabs) {
   const active = tab.id === "tab-" + name;
   tab.setAttribute("aria-selected", String(active));
   tab.tabIndex = active ? 0 : -1;
   host.querySelector<HTMLElement>("#" + tab.getAttribute("aria-controls"))!.hidden = !active;
  }
  onOpen(name);
 }
 for (const tab of tabs) {
  tab.onclick = () => open(tab.id.slice(4));
  tab.onkeydown = event => {
   const visible = tabs.filter(button => !button.hidden);
   const index = visible.indexOf(tab);
   const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: visible.length - 1 }[event.key];
   if (next === undefined) return;
   event.preventDefault();
   const target = visible[(next + visible.length) % visible.length];
   target.focus();
   target.click();
  };
 }
 return {open};
}
