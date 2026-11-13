// Stable intake scope; member and installation are independently verified server-side.
export const intakeFocus = {
  kind: "planning-board",
  id: "00000000-0000-4000-8000-000000000002",
  label: "Project intake",
  revision: 1,
} as const;

/** Stable conversation scope for the organization product page. */
export const productsFocus = { kind: "planning-products", id: "00000000-0000-4000-8000-000000000003", label: "Products", revision: 1 } as const;

export const videosFocus={kind:"planning-videos",id:"00000000-0000-4000-8000-000000000004",label:"Video productions",revision:1} as const;
