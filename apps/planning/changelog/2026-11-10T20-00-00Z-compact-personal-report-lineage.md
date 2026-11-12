# Keep personal overviews within the report transport bound

Personal overviews retain compact organization summaries and exact organization source revisions instead of repeating every nested repository observation. They keep the first three projects in personal order plus every project with an owning question or truncated decision coverage; omitted project references and total/incomplete counts remain explicit. The exact organization note revision transitively retains the full project report lineage.

Goal summaries retain titles, unknown observation status, all captured source references/digest and coverage errors, without repeating authored goal bodies or formula prose. No measurement or standup result is inferred. Other report levels and the atomic generated-only write path are unchanged.

A fixture with seven organizations (fourteen projects in the largest, twenty overall), one personal project and seven goals now round-trips below 32 KiB with stable retry. Regression checks retain source coordinates, incomplete/omitted counts and unanswered/truncated decision ownership. Truly oversized inputs still fail before changing a document.
