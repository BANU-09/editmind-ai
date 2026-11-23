# EditMind AI assessment report

The assessment entry point is **Editing session** in the workspace. It shares the same project, preview, history and media renderer as the editor. The API runner creates an isolated editing branch over an uploaded source and saves the steps, intermediate decisions, timeline hash, final MP4 and interchange file.

[Live editor](https://editmind-ai-banu09.vercel.app/) · [Run the sessions](README.md) · [Timeline design and rules](docs/timeline.md) · [HTTP contract](openapi.yaml)

## What the checks measure

| Area | Check and evidence |
|---|---|
| Edit semantics | Scripted cases assert the status, original-source intervals, duration, caption projection, history, ambiguity handling, atomic rejection and replay hashes. [Session engine tests](server/sessionEngine.test.ts) |
| Render accuracy | The tests decode MP4 frames and PCM samples, locating flashes and associated sound pulses after edits. Across the tested outputs, maximum absolute A/V offset was 0.80 frame and maximum video-length error was 0.44 frame. [Measured results](evidence/render-accuracy.json) |
| Original audio and music | Twenty narration joins met waveform checks. Minimum correlation across the join windows was 0.99881. The measured preview/export instrumental-bed correlation was 0.999994. The perceptual check requires listening to the twenty joins. [Listening reel](evidence/speech-listening-reel.mp3) |
| Interchange | The official Python OpenTimelineIO adapter loaded and round-tripped an edited project with a cut, speed change, mute and anchored caption. The fixture had 46 audio/video clips and a duration of 81.58 seconds. [Verification script](scripts/verify-timeline.py) |
| Integration | The HTTP test exercises guest isolation, concurrent retry keys, edit revision conflicts, MP4 delivery, source preservation, manifests and HMAC callback verification. It uses a controlled STT provider to isolate HTTP behavior. The separate media pipeline test exercises CPU speech recognition on spoken inputs. [HTTP test](server/sessionApi.test.ts) · [Media pipeline](server/pipeline_e2e.test.ts) |

The repository is public at the candidate's request. The production service can cold-start after inactivity. The assessment tests exercise published cases and synthetic fixtures. Reviewers can run their own videos and instruction sequences using the same runner.
