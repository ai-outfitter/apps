Prepare a Forerunner discovery proposal for verified account holder Mika Vale. Record connections supported by the attached source excerpts. Before creating records, search the graph by the account holder's reported name and the identified operator's legal name. Compare the lookup records using the available identifying details. Reuse saved record IDs where the evidence matches. Look up other likely existing identities before proposing them.

Return one JSON object with these fields:
- `nodes` has each newly proposed record with `id` (a local handle), `type`, `name` and `evidence` (a list of source IDs).
- `edges` has each supported directed connection with `type`, `from`, `to` and `evidence`. Use a new node's local handle or an existing graph ID as the endpoint.
- `decisions` has one entry each for `product_use` and `product_developer`. Include `question`, `action` (record or defer), `evidence` and a short `reason`. Add the corresponding edge if you choose record.

Use the type identifiers from the context. Cite source excerpts that support each node or connection and substantiate each decision. Do not write to any system.
