# #284 evidence notes

The original receipt blobs remain byte-for-byte as committed. They describe prior exact source pairs and retain their original grading semantics. The real DGX records are read-only evidence. The executable runner uses the in-container synthetic provider with networking disabled.

| Receipt | Apps | webapp | Result |
| --- | --- | --- | --- |
| [Original](receipts.json) | `4e1e0544` | `556e6d11` | Seven natural calls, including 66.568 s and 121.518 s capped calls. Faster calls returned verified cited artifacts. Five controls passed. |
| [Intermediate](receipts-8a3ed89a.json) | `4e1e0544` | `8a3ed89a` | Six completed natural calls, including a 70.081 s capped call, and one interrupted request. Four controls passed. |
| [Stable](receipts-2b133612.json) | `39b10056` | `2b133612` | Two long real calls returned `output_limit` at 92.964 s and 104.461 s. A 32.110 s call returned a verified cited artifact. The controlled 103.033 s success and four other controls passed. |

The separate historical success at 66.738 s belongs to Apps `0a111c0` and webapp `515571a`. It does not satisfy a later pair's combined unpaced duration-and-artifact grade.

## Historical grading and fixture provenance

- The intermediate private grader was byte-identical to the grader in `821e4b9cc302853e9856b1158ef7b063d1acda24`. Its `matchingProductMeter` check depended on a successful provider response over 60 seconds. Each of the six completed natural calls records a true independent `providerMeterAgrees` alongside the original false historical check. The audit reproduced all 11 stored grades and confirmed that separating meter equality leaves all six combined grades unchanged. Historical checks came from a looser meter matcher. The new offline grader uniquely joins the workflow run and HTTP attempt before comparing tokens.
- Archived fixture commits `38ac2e759d35cde6f106786fd4db356d49448bed` and `538c2633ab24587bef0efe928661261f050e480d` came from the original workstation's signed Git fixture provenance. The audit located the signed synthetic commit in the private bundle. New replays use the fixed unsigned commit IDs in `fixtures/repositories.txt`. The exact README bytes remain the same.
- The archived live matrix case `11-exact-284-spark-matrix` names `legacy-cases.json` SHA-256 `6b8d3b6498a60c3299e1ce7ddaa2ddfffc9442e51e4fa0145e450ed5fa3bfef9`. Those exact bytes are unavailable in either archived evidence commit. The tracked legacy fixture's SHA-256 was `1634cca7d2523a91acb48f8aad2b8156f9fee20d91194c5b0d04534eab71b7e4`. Legacy seeding was inactive in that live arm. The audit matched the selected scenario and repository fixtures. The old digest remains verbatim in the receipt.
- Real model scenario JSON files are historical inputs kept for digest comparison. The offline runner reads only `scenario.json`, the two READMEs and the relevant synthetic state fixture. Raw historical responses, full plans, provider credentials, runtime databases and container logs stay private.

## Audited offline replay on webapp 90550833

[Sanitized offline receipts](receipts-offline-90550833.json) record Apps `22fd6178b9dfefdfc801c3798e702b6f2bab3b7c` and webapp `905508330e2aeab9bf5e34b2b816e07dce708134`. All six cases passed on the pinned image and operational bundle. The controlled response exceeded 103 seconds and returned an authenticated artifact with the matching run and attempt meter. The fixture commits matched under clean and signing-enabled Git environments.

The interrupted-collection case seeded a completed output slot for each running workflow. Two concurrent same-ID calls settled the typed failure and the rejected draft while preserving the stored slot bytes, history and the draft artifact digest. A divergent completed slot stayed unchanged with the run still running. The case made zero provider requests. Repository readback found zero issues and PRs throughout the replay.
