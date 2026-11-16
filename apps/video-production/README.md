# Video production

Creative briefs, storyboards, shots and visual references as records in the
organization's Onto. Press release: [docs/press-release.md](docs/press-release.md).

## Ontology

The app owns these types and adds them to the organization's Onto add-only, with
fixed IDs (`src/server/onto.ts`). An Onto that already has a type at the same ID
and name (Sunny's, staged before the app existed) keeps it as it is: setup never
changes a type.

| Type | ID | Properties |
| --- | --- | --- |
| `CreativeBrief` | `c24f0c82-…` | audience, single_message, claim_boundary, call_to_action, success_metric, status |
| `Storyboard` | `ebeaaf8a-…` | duration_seconds, aspect_ratio, variant, opening, status |
| `Shot` | `7964f188-…` | sequence (required), start_seconds, duration_seconds, beat, action, camera, voiceover, overlay, sound, transition, source_route, claim_status, status |
| `VisualReference` | `e968edf4-…` | status, requirements, file_uri, version |

| Relationship | From → to |
| --- | --- |
| `promotes` | CreativeBrief → Product or Offering |
| `follows_brief` | Storyboard → CreativeBrief |
| `shot_of` | Shot → Storyboard |
| `uses_reference` | Shot → VisualReference |
| `cut_from` | Storyboard → Storyboard |

Order and timing are properties, never title text. A storyboard is a plan, not
evidence a video exists. A reference with no `file_uri` is a requirement.

## Pages and documents

| Page | What it shows |
| --- | --- |
| `/` | Storyboards grouped by the brief they follow |
| `/storyboards/<slug or id>` | One storyboard's shots in sequence order and the references they need |

The app keeps no database of its own: pages and the `Storyboards` document read
the Onto through the platform graph client. `StoryboardChanges` (the
`StageStoryboard` mutation) adds the types, then stages a brief, a storyboard, its
shots and references as one Onto change batch and submits it for review. Records
and links the Onto has are not proposed again; existing records are not changed.

## Evals

`evals/launch-videos/` gives two separate Ontos (Sunny, Outfitter) the same
request: plan launch videos with storyboards of shots. The reference answer is the
types above; see its README.

## Tests

`npm test --workspace @ai-outfitter/app-video-production`: unit tests for the type
declaration, setup, the read model, staging and the eval grader, and a browser spec
over a seeded Onto.
