// Text written by other people (mail, events, fetched pages, and what was
// inferred from them) before it reaches a model or the page. Connector readers
// return it raw; the platform frames it here, so every feature cuts and fences
// it the same way.

/** Removes data markers, so the text cannot close or forge a `<<<DATA … DATA>>>` fence. */
export const unmarked = (text: string) => text.replace(/<<<|>>>/g, " ");

/** One line without data markers: whitespace collapsed and trimmed. */
export const flat = (text: string) => unmarked(text).replace(/\s+/g, " ").trim();

/** At most `max` characters of one flat line, cut without an ellipsis (for data rows). */
export const cut = (text: string, max: number) => flat(text).slice(0, max);

/** At most `max` characters, ending in an ellipsis when shortened (for text people read). */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Text for a model as data: a label saying whose words they are, then the text without data markers, fenced. */
export const fenced = (label: string, text: string, max = Number.POSITIVE_INFINITY) =>
  [label, "<<<DATA", unmarked(text).slice(0, max), "DATA>>>"].join("\n");
