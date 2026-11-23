# Sources and media credits

## Project and assets

The starting application and its existing UI assets came from the BANU-09 EditMind AI source archive. The earlier public revision records the original in-app still images, scripts and project history. Their filenames alone do not identify a third-party photographer or licence. The candidate supplied the project's commercial-use attestation. Rights for a user's own upload are supplied by that user. [Project history](https://github.com/BANU-09/editmind-ai/commits/main/)

The five bundled demo-narration tracks are synthesized performances of the demo dialogue, using Kokoro voices af_heart, af_bella, am_michael, am_fenrir and af_nicole. The built-in instrumental bed is generated from notes and envelopes in the project. The two-voice studio test video consists of an FFmpeg-generated color background and original dialogue synthesized with Flite. The render checks generate their own test tones and visual markers. The speech join reel uses excerpts of the bundled demo narration. [Kokoro model card, Apache-2.0](https://huggingface.co/hexgrad/Kokoro-82M) · [Flite and its component notices](https://github.com/festvox/flite) · [Session fixture generator](scripts/make-session-fixture.py) · [Music synthesis](src/shared/musicBed.ts)

## Models and media software

| Component | Use and source |
|---|---|
| Whisper base and Transformers.js | CPU transcription and word timestamps. [Whisper](https://github.com/openai/whisper) · [ONNX conversion](https://huggingface.co/Xenova/whisper-base) · [Transformers.js](https://github.com/huggingface/transformers.js) |
| Qwen2.5-1.5B-Instruct and Qwen3-4B-Instruct-2507 | Conversational assistant models. The deployment script pins GGUF downloads and verifies checksums. [Qwen2.5](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) · [Qwen3](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) · [Exact artifacts](scripts/start-edit-model.sh) |
| llama.cpp | CPU inference for the conversational assistant. [License and source](https://github.com/ggml-org/llama.cpp) |
| FFmpeg and FFprobe | Audio decoding, synthesis, export and frame measurements. Licence depends on the build and enabled codecs, including libx264. [FFmpeg licensing](https://www.ffmpeg.org/legal.html) |
| OpenTimelineIO | Interchange model and independent Python adapter used for verification. [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) |
| SeaweedFS | S3-compatible object store for the local Compose deployment. [SeaweedFS](https://github.com/seaweedfs/seaweedfs) |
| Vercel | Hosted web app, sandbox and storage services. [Production setup](DEPLOY.md) |

## Dependencies

React, Vite, TypeScript, Express, better-sqlite3, the AWS SDK, Vercel SDKs and the other JavaScript dependencies resolve through [package-lock.json](package-lock.json). The [dependency inventory](docs/dependencies.json) records each resolved package version and the licence metadata in that lockfile. Package-specific licence notices accompany their distributions. The native container dependencies are listed in the [Dockerfile](Dockerfile). Google's Gemini SDK supports optional deployments configured with the operator's own key.
