# Workshop

Workshop is an Outfitter app for physical product projects: the record, the CAD and the design agent for people building ambitious hardware, from a field sensor node to a robotics prototype. [docs/vision.md](docs/vision.md) is the long-term vision and the ambition ladder every eval and example sits on. It includes a read-only demo and an operational mode with an installation database, storage and Wiki dependency. Organization admins install it from the catalog. Agents use it over MCP: the documents in `src/server/documents.ts` marked with `publishDocuments`, on the platform `/mcp` endpoint or on Workshop's own `/mcp/workshop`.

Run `npm run check --workspace apps/workshop`, `npm run test --workspace apps/workshop`, and `npm run build --workspace apps/workshop` from the repository root. Browser tests require Playwright Chromium. Packages are written to `.outfitter/packages/` for the shared release tooling.
