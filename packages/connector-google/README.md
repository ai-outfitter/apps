# Google OAuth transport

Private shared OAuth/HTTP transport for the Gmail and Google Calendar connectors.
The webapp owns authorization state, user ownership, encrypted grants and refresh
persistence. Sign-in accounts are separate from these grants: connecting another
email never links a login identity or grants access to another user's data.

## Setup

Create a dedicated Google Cloud **Web application** OAuth client for Google
Workspace; do not reuse the sign-in client. Enable Gmail API and Google Calendar
API, configure the consent screen and test users, and register this exact
redirect URI:

`https://ai-outfitter.com/api/connectors/google/callback`

Set `GOOGLE_CONNECTOR_CLIENT_ID`, `GOOGLE_CONNECTOR_CLIENT_SECRET` and
`GOOGLE_CONNECTOR_REDIRECT_URI` on the server. Sign-in keeps its own
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. For another installation use its
own origin; previews need their own registered callback and credentials. Connector buttons stay disabled until all three settings
are present. Tokens never go to the browser.

Each user can connect several accounts for Gmail and several for Calendar at
`/connectors`. Reconnecting the same Google account updates only its corresponding
connector. Disconnect removes that grant from Outfitter, stopping further access;
it does not revoke other grants for the same OAuth client at Google.

One consent asks for reading (`gmail.readonly`, `calendar.readonly`) and for the
two writes a member's own action makes (`gmail.compose` to save a draft, never
sent by Outfitter; `calendar.events` to add an event without invitation email), plus
verified email identity (`scopes` in `src/index.ts`). Reading alone still
connects (`grantedProviders`); a write without its scope fails with 403
`google-write-scope`, and connecting the account again asks for it
(`writeGranted`). The packages expose `createDraft` and `createEvent` beside
their readers; the platform holds the token. Offline consent allows server-side
token refresh.
Gmail's restricted scopes may require Google's verification/security assessment
for public distribution. In Google's Testing mode, offline grants for these scopes
expire after seven days ([Google token expiry](https://developers.google.com/identity/protocols/oauth2#expiration)); reconnect until the consent app is ready for production.

References: [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).
