# Read a page and its document in one request

`page(slug)` now offers `document(revision)`, so a reader that knows a page's slug gets the document without a second request. A document also reports the `installationId` of the Wiki that holds it, which with `id` and `revision` is its whole address.
