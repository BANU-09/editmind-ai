# EditMind AI assessment report

The assessment entry point is **Editing session** in the workspace. It shares the same project, preview, history and media renderer as the editor. The API runner creates an isolated editing branch over an uploaded source and saves the steps, intermediate decisions, timeline hash, final MP4 and interchange file.

[Live editor](https://editmind-ai-banu09.vercel.app/) · [Run the sessions](README.md) · [Timeline design and rules](docs/timeline.md) · [HTTP contract](openapi.yaml)

## What the checks measure

The structured session and the conversational assistant solve different problems. Free-form conversation benefits from model interpretation. Repeatable edits need an operation history whose meaning survives undo, retries and renderer changes. An explicit operation list lets the client compare the timeline hash after each instruction. Storing word anchors on the original time axis also avoids repeatedly rewriting subtitle times after every cut. Source projection costs additional work at preview and render time, particularly when footage is reordered. [Timeline rules and tradeoffs](docs/timeline.md)

| Area | Check and evidence |
|---|---|
| Edit semantics | Scripted cases assert the status, original-source intervals, duration, caption projection, history, ambiguity handling, atomic rejection and replay hashes. [Session engine tests](server/sessionEngine.test.ts) |
| Render accuracy | The tests decode MP4 frames and PCM samples, locating flashes and associated sound pulses after edits. Maximum absolute A/V offset was 0.80 frame. The signal-test outputs had a maximum video-length error of 0.44 frame. Including the 15 session exports raised the largest measured length error to 0.45 frame. [Signal measurements](evidence/render-accuracy.json) |
| Original audio and music | The candidate listened to all 20 narration joins and reported zero audible word clips. Separately, minimum source correlation across the join windows was 0.99881. The measured preview/export instrumental-bed correlation was 0.999994. [Listening reel](evidence/speech-listening-reel.mp3) |
| Interchange | The official Python OpenTimelineIO adapter loaded and round-tripped an edited project with a cut, speed change, mute and anchored caption. The fixture had 46 audio/video clips and a duration of 81.58 seconds. [Verification script](scripts/verify-timeline.py) |
| Integration | The HTTP test exercises guest isolation, concurrent retry keys, edit revision conflicts, MP4 delivery, source preservation, manifests and HMAC callback verification. It uses a controlled STT provider to isolate HTTP behavior. The separate media pipeline test exercises CPU speech recognition on spoken inputs. [HTTP test](server/sessionApi.test.ts) · [Media pipeline](server/pipeline_e2e.test.ts) |

The repository is public at the candidate's request. The production service can cold-start after inactivity. The assessment tests exercise published cases and synthetic fixtures. Reviewers can run their own videos and instruction sequences using the same runner.

## Replaying a two-speaker upload

The public studio fixture is 120 seconds long. Fifteen independent sessions supplied 43 instructions and three clarification answers. All fifteen produced an MP4. Three fresh runs per session matched on status, response code, duration and timeline hash at every step over the same transcribed source. The three deliberately ambiguous inputs each asked for clarification. Four invalid instructions were rejected.

In the eight-step session, Whisper identified the four source words at 42.212–43.456 s. Cutting the first 30 seconds moved their caption to 12.212–13.456 s. Restoring the intro and undoing the restoration moved it back and forth on the same words. In the exported MP4, the first and last visible red frames were within one 15 fps frame of the decoded speech boundaries. [Reproduce the session](testpack/sessions/01-editor-session.yaml) · [Check the pixels and audio](scripts/check-caption-audio.mjs)

The official OpenTimelineIO reader opened all 15 final exports and round-tripped 380 clips referencing the included source. An extra repeat-encode check produced different AAC bytes in one output. Its decoded video matched and its audio had the same sample count and a correlation of 0.999999985. [Session measurements](evidence/public-test-pack.json) · [OTIO verification](evidence/otio-validation.json) · [Download all 15 rendered examples](https://github.com/BANU-09/editmind-ai/releases/tag/assessment-2-verified)

The overlapping-speech test mixed two synthesized speakers for 0.443 s over a music bed in a variable-frame-rate source. Whisper returned a single anonymous speaker label and the editor warned that voices could overlap. An intentionally inconsistent word/turn label in the reference timeline triggered an additional warning. Automatic speaker identity remains uncertain on overlapping uploads. [Run the combined fixture](scripts/check-speaker-overlap.mjs)

Five additional public-API practice cases exercised a caption inside a retimed excerpt, disambiguation of a repeated word, redo after a new edit, overlapping rates, and an invalid multipart edit. All 16 instructions matched the expected decision and duration. The 13.000-second MP4 showed the red caption from 3.000 to 4.000 seconds. These are project-authored checks. IncuBrix runs its own unseen cases. [Predictions and runner](scripts/practice-edits.mjs) · [Measured results](evidence/practice-edits.json) · [Rendered excerpt](evidence/practice-retimed-caption.mp4)

## Deployment and storage

The Compose integration test saved the MP4 and manifest to SeaweedFS, recreated both containers, and downloaded the same bytes by job ID. The tested MP4 was 352,620 bytes with SHA-256 `b77483f0901133bb41d5d992c8553c65f4509428fea91087636692c2a660aa43`. The hosted app uses a persistent Vercel Drive. Both CPU speech recognition and the structured session engine ran without metered model API calls. Infrastructure costs depend on the operator's hosting rates. [Initial storage check](evidence/compose-roundtrip.json) · [After restart](evidence/compose-restart.json)

## Transcription cost estimate

For transcription alone, the five-minute upload reported 34.298 seconds of STT time and the hour-long upload reported 406.602 seconds. At Vercel's published starting rates, an illustrative worker with two fully active vCPUs and 4 GB provisioned memory costs $0.3408/hour. Applied only during those STT windows, this gives approximately $0.00065 and $0.00064 per source minute respectively. The estimate excludes idle time, upload, render, storage, transfer and allowances. The project did not have a per-job invoice. [Inputs and formula](evidence/transcription-cost.json) · [Vercel pricing](https://vercel.com/pricing)

## Deployed instruction latency

Worker `4b328eb745deff3b` served 12 instructions on each of two previously transcribed uploads, repeated on three fresh sessions per upload. The client clock ran from sending the HTTP step through receiving its complete response, using the discovered worker as the app and runner do. Transcription, session creation and rendering are separate operations. Each of the 72 decisions matched its expected status and each step produced the same hash across the three runs.

| Upload | Words | Responses | Client median | Client slowest | Server median | Server slowest |
|---|---:|---:|---:|---:|---:|---:|
| 5 minutes, 320 × 180 at 15 fps | 247 | 36 | 0.631 s | 0.723 s | 0.005 s | 0.013 s |
| 60 minutes, 240 × 136 at 2 fps | 7,625 | 36 | 0.711 s | 0.821 s | 0.090 s | 0.231 s |

An earlier deployed build took 3.467 s for one hour-long edit. The final build stores the immutable original once and compresses large session updates. Raw measurements retain both runs. These timings describe the structured editing API. Browser interaction and the conversational model incur additional work. [Final timings](evidence/latency.json) · [Earlier hour-long outlier](evidence/latency-bca792e7.json)

On the deployed browser interface, the same 12 conversational prompts on a 90-second keynote passed again. Median conversational response time was 3.025 seconds and the slowest was 8.981 seconds. A separate fresh upload produced the expected garden-gate transcript. The browser applied a cut, undid it, requested clarification, accepted cancellation and downloaded an H.264/AAC MP4. Its first structured edit took 6.392 seconds including session setup and visible completion. A thumbnail request failed during project loading. [All 12 prompt times](evidence/conversation-prompts.json) · [Browser upload and export checks](evidence/live-browser.json)

## Remaining engineering work

Overlapping speech is the main limitation for speaker-specific edits. The next experiment would compare independently labeled two-speaker recordings against diarized turns, measure incorrect speaker assignments, and preserve the current clarification behavior wherever attribution is uncertain. For operational cost, collecting active CPU seconds by job would replace the full-utilization assumption with a measured allocation.
