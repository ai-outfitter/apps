# Share a D1 session within each operational app request

The canonical SDK's app middleware now opens a first-primary D1 session per
operational request. Installation Drizzle and prepared-batch adapters reuse
that session, so later reads can use replicas with sequential consistency.
The standard Astro integration and legacy dataAppMiddleware both receive it;
read-only demos do not open database sessions.

Database provisioning must enable replication, and affected apps must be
rebuilt and deployed against the updated SDK. The companion webapp PR handles
provisioning and configuration audit. Neither passing SDK tests nor enabling
the database setting proves a live request used a replica.

The first query remains primary. Cross-app bookmarks, unconstrained first
reads, private HTML caching, broad offline behavior and daily brief/sidebar
query optimization remain deferred. Database calls outside middleware keep the
primary binding; asynchronous callbacks created inside a request inherit its
session context. No cross-request state or data is cached.
