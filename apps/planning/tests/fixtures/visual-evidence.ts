export const capture = {
  schemaVersion: 1,
  recordKind: "visual-evidence",
  title: "Review a captured change",
  summary: "Show what changed in the running app.",
  project: { id: "98000000-0000-4000-8000-000000000009", revision: 1 },
  productRevision: { id: "98000000-0000-4000-8000-000000000010", revision: 1 },
  capturedAt: "2026-11-17T12:00:00Z",
  source: {
    repository: "https://github.com/ai-outfitter/apps",
    commit: "a".repeat(40),
    environment: "local",
    seeded: true,
    dirty: false,
  },
  steps: [
    {
      id: "review",
      title: "Review the project",
      description: "Open the captured project and inspect its outcome.",
      media: [
        {
          id: "screen",
          kind: "screenshot",
          caption: "Running project page",
          href: "/capture.png",
          sha256: "b".repeat(64),
          contentType: "image/png",
          owner: "planning",
        },
      ],
    },
  ],
  limitations: ["Seeded local capture; not production acceptance."],
};
