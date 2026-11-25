Prepare a Forerunner discovery proposal for the verified account holder, Mika Vale, using the supplied evidence. Cover positive connections supported by the batch. Before proposing each identity, use the existing graph lookup to reconcile likely matches. Explain whether this batch supports recording actual product use or naming the product developer.

Return one JSON object with these fields:
- `nodes`: newly proposed records only, each with `id` (a local handle), `type`, `name`, and `evidence` (a list of evidence IDs).
- `edges`: each with `type`, `from`, `to`, and `evidence` (a list of evidence IDs). Endpoints may refer to new nodes or existing records by ID.
- `decisions`: one entry each for `product_use` and `product_developer`, with `question`, `action` ("record" or "defer"), `evidence` (the IDs considered), and `reason` (one or two sentences explaining what the evidence supports or what is missing).

Use the identifiers declared in the graph type context. The evaluator will check the submitted proposal. Do not write to any system.
