# Video production: plan launch videos as records, not documents

Draft press release, written before the work (press-release-first). Status: draft.

**For marketing and product teams who plan short videos for their products: turn a
creative brief into storyboards and shots linked to the products they promote, and
see which shots are still waiting on visual references.**

## The customer

A small team launching products. They plan a few short videos per launch: a
15-second social cut, a 6-second bumper, a longer demo. Their agents already help
write the plan.

## The problem

Today the plan ends up as documents. The length is in the title ("Find your spot
(15s)"), the shot order is in the title ("01 — Hook"), and "this shot needs the
final app screen" is a sentence in a paragraph. Nobody can ask "which shots of the
sensor video are blocked?" without reading everything, and two agents asked for the
same plan file it two different ways.

## The solution

Video production gives the organization's Onto four kinds of record: a creative
brief (audience, one message, what it may claim, call to action), a storyboard
(one video: length, aspect ratio, variant), a shot (its place in the sequence,
timing, beat, what we see, voiceover, overlay, sound) and a visual reference (what
shots must match, and whether a file exists yet). Briefs link to the products they
promote, shots to their storyboard and to the references they need.

The app shows every storyboard grouped by brief, and each storyboard's shots in
order with the references they need. A reference with no file shows as a
requirement, so blocked shots stand out. Agents read the same thing through the
`Storyboards` document and save plans through `StoryboardChanges`, which stages
one Onto change batch a member reviews.

## Getting started

Install Video production in the organization. It adds its record types to Onto
once. Ask an agent to plan launch videos from a brief; review its batch in Onto;
open Video production to see the storyboards.

## In scope

- Briefs, storyboards, shots and visual references as Onto records with fixed type
  IDs, the same in every organization.
- A storyboards page grouped by brief, and a storyboard page with shots in order.
- Agents read storyboards and stage new ones for review.

## Not yet

- Editing in the app. Change records in Onto, or ask an agent.
- Uploading reference files. A reference holds a link to its file.
- Sending shots to a video model to generate footage. This comes later, shot by
  shot, once the references a shot needs are locked.
- Converting older plans saved as Documents. That is a separate Onto batch.
