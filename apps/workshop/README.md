# Workshop

Workshop is an Outfitter app for physical product projects: the record, the CAD and the design agent for people building ambitious hardware, from a field sensor node to a robotics prototype. [docs/vision.md](docs/vision.md) is the long-term vision and the ambition ladder every eval and example sits on. It includes a read-only demo and an operational mode with an installation database, storage and Wiki dependency. Its catalog access remains restricted to administrators.

Run `npm run check --workspace apps/workshop`, `npm run test --workspace apps/workshop`, and `npm run build --workspace apps/workshop` from the repository root. Browser tests require Playwright Chromium. Packages are written to `.outfitter/packages/` for the shared release tooling.

## Sidebar assistant

Ask Workshop opens the shared private conversation sidebar on every page, including
New model. It reads up to 20 saved projects with assembly items and current build
evaluations (vision tier 2 inspection). It cannot modify models or start builds;
the existing creation and workspace flows perform those actions. Conversations use
the platform thread service and the installation-scoped agent tables. Demo replies
are scripted. Operational installations need `threads.use` and `threads.provide`.
## Workspace assemblies

Model source belongs to a project repository. Workshop reads immutable component
meshes, assembly structure, BOM and test evidence produced in a workspace.
The browser inspects results; builds run in Kubernetes workspaces or the shared
sealed app box for local development. See [box/README.md](box/README.md).
Project-specific models and dimensions must never be added to app source.

