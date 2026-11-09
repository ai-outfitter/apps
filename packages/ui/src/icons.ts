// Shared SVG path data for the React chat island and Astro pages.
export const iconPaths = {
  home: "M3 11 12 3l9 8 M5 10v10h14V10 M9 20v-6h6v6",
  book: "M4 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4Z M20 4h-4a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h4Z",
  admin: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z M8 12l3 3 5-6",
  organization:
    "M4 21V3h12v18 M2 21h20 M16 9h4v12 M8 7h4 M8 11h4 M8 15h4 M9 21v-3h2v3",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  plugins: "M3 3h7v7H3Z M14 3h7v7h-7Z M3 14h7v7H3Z M14 14h7v7h-7Z",
  workflow: "M5 3v12a4 4 0 0 0 4 4h10 M15 15l4 4-4 4 M5 7h14 M15 3l4 4-4 4",
  inference:
    "M6 6h12v12H6Z M9 9h6v6H9Z M9 2v4 M15 2v4 M9 18v4 M15 18v4 M2 9h4 M2 15h4 M18 9h4 M18 15h4",
  send: "M12 20V4 M5 11l7-7 7 7",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.6-2L20 8 M4 16l2.3 3A7 7 0 0 0 17.9 17",
  stop: "M6 6h12v12H6Z",
  down: "M12 4v16 M5 13l7 7 7-7",
  download: "M12 3v12 M7 10l5 5 5-5 M4 16v4h16v-4",
  compose:
    "M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7 M16 3l5 5 M10 14l-1 4 4-1 9-9a2.1 2.1 0 0 0-5-5Z",
  workspace:
    "M4 4h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M8 22h8 M12 18v4 M7 8l3 3-3 3 M13 14h4",
  folder:
    "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z",
  plus: "M12 5v14 M5 12h14",
  settings: "M4 6h9 M17 6h3 M15 4v4 M4 12h3 M11 12h9 M9 10v4 M4 18h9 M17 18h3 M15 16v4",
  logout: "M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4 M10 12h11 M17 8l4 4-4 4",
  sidebar:
    "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M9 3v18",
  arrow: "M6 18 18 6 M6 6h12v12",
  spark: "M12 2v20 M2 12h20 M5 5l14 14 M5 19 19 5",
  idea: "M9 18h6 M10 22h4 M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z",
  compass: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M16 8l-3 5-5 3 3-5Z",
  code: "M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18",
  check: "M5 12l5 5L20 7",
  thread: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z M8 10h8 M8 14h5",
  back: "M19 12H5 M11 6l-6 6 6 6",
} as const;

export type IconName = keyof typeof iconPaths;
