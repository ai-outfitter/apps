# Personal and shared portfolio ordering

Personal Planning projects do not require an organization. `PriorityOrder` and
`ReorderPriority` keep local project/product order in the owning installation,
including personal installations.

`PersonalPortfolio(kind: "organizations" | "projects")` reads authorized records
and the personal installation's independent order. `ReorderPersonalPortfolio`
accepts the complete current list and its revision. These documents are personal
only: an organization installation cannot read or change a person's portfolio.

Organization keys are authorized organization slugs. Project keys are
`<organization-slug>:<project-uuid>` or `personal:<project-uuid>`. Shared project
IDs alone cannot express cross-organization ordering. Each write re-reads the
member's authorized set through the platform's existing Viewer/PortfolioProjects contracts.
Revoked references are omitted from reads; stale, incomplete, duplicate or
unauthorized writes fail. New authorized records append to the current order.
Provider failures never become an empty authoritative portfolio.

The existing installation-scoped priority table stores the two additional kinds;
no data migration or shared-order rewrite is required. Portfolio ordering does
not determine lifecycle state or automatic execution priority. Recurring project
reports select explicitly active projects separately.

Personal daily overviews apply this private organization and project order to
authorized captured reports. Ordering never widens report access or changes an
organization's shared order. The existing Planning home card links to the saved
previous-day overview and retains missing-source warnings.
