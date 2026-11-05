# Hello Outfitter

A small SDK-free app demonstrating the official `apps/<app>/` layout and shared
PR preview workflow. It serves an actual read-only page and publishes source
provenance at `/api/health`. It has no production mode, customer data or platform
API and does not stand in for migrating an existing catalog app.

Run `npm run preview:build --workspace @ai-outfitter/app-hello-outfitter` from the
repository root. The same shared publisher used by personal apps deploys the
demo artifact; no app-specific deployment scripts or credentials live here.
