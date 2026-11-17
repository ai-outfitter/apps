# Keep the platform assistant beside managed app pages

Operational managed layouts now accept an optional platform-dispatched sidebar endpoint and derive the private thread from the authenticated member and owner. Their Ask Outfitter island uses the same persistence identity as workspace pages. Existing app agents remain separate reviewed conversations.

Mounted page routing now uses a static same-origin script and inert configuration metadata. It releases its previous fetch/history adapter before an Astro page swap and installs the incoming page's adapter afterward; new response nonces are not used to authorize executable routing code in the old document. The platform sidebar uses an absolute owner endpoint independent of the current app mount.

Personal `/apps/<slug>` installations keep their restrictive path CSP and do not receive the global panel. Demos, anonymous pages, older app packages, and layouts outside the shared managed shell do not gain the panel. External apps require an updated public UI package and ordinary installation deployment. Navigating outside participating same-origin layouts still reloads the page.

Validation includes member/owner thread identity and external-member refusal, response rewriting, and a CSP-enabled browser routing fixture. Full application navigation and release evidence are recorded with the coordinated PR.
