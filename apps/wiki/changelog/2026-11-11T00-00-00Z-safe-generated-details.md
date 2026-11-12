# Render collapsed generated provenance safely

Generated report sections support exact top-level details/summary wrappers while authored Markdown keeps its existing renderer. The whitelist parser respects fenced code, scans unclosed wrappers once, and leaves raw HTML and unsafe links under micromark's default escaping.

Tests cover collapsed provenance, script/protocol refusal, literal fenced examples and unclosed wrappers.
