# EditMind AI

EditMind turns instructions about a video into reversible timeline edits. Upload a source or open a narrated demo, choose **Editing session** in the workspace, and enter a command such as `Cut the first 10 seconds`. The reply shows the operation, duration and time policy. Preview the change, then export an MP4. **AI conversation** is available for open-ended questions.

[Open EditMind](https://editmind-ai-banu09.vercel.app/) · [Assessment report](REPORT.md) · [API guide](docs/api.md) · [Timeline rules](docs/timeline.md)

## Run locally

From the repository root, start the web app, SQLite-backed job service and S3-compatible object store with Docker Compose. The first speech transcription downloads Whisper weights.

```sh
docker compose up --build
```

Visit http://localhost:3000 and check readiness at http://localhost:3000/ready. Configuration defaults and overrides are in [.env.example](.env.example). The Compose service stores the database and uploaded files in named volumes. The production website has a separate persisted deployment described in [DEPLOY.md](DEPLOY.md).

For development or tests on the host, install Node.js 24, npm, FFmpeg with FFprobe, libx264, libass and libflite, and a font such as DejaVu Sans. Install locked dependencies once with `npm ci`. Run `npm test` to start an isolated HTTP server and execute the unit, session, media and integration tests. Local speech recognition runs on CPU. A cold test installation needs network access to fetch the speech model. Use `npm run lint` for TypeScript and `npm run build` for the web bundle.

## Run the assessment sessions

```sh
npm run session -- --in testpack/sessions --out results --base http://localhost:3000
```

Supply a YAML/JSON file or a folder and an empty output directory. The CLI uploads the file or imports its URL, opens an independent session, sends the steps in order, resolves supplied answers, and downloads the final MP4, timeline JSON, OpenTimelineIO file and available manifest. It also records each raw structured response and the elapsed client time. The included pack shares one source across fifteen independent edit histories. Use `--base https://editmind-ai-banu09.vercel.app` for the hosted service. Session requests use a client-generated guest identity. Keep it private to retain access to your own projects.

The [sample MP4](testpack/media/studio.mp4) contains two synthesized voices with originally scripted dialogue. Regenerate it with `python scripts/make-session-fixture.py testpack/media/studio.mp4`. The [session inputs](testpack/sessions) include time edits, ambiguity, captions, reordering, music, undo, redo and rejection. The versioned HTTP interface and job polling schema are in [openapi.yaml](openapi.yaml).

## Errors

HTTP failures have an `error` object containing `code`, `message`, `retryable` and `details`. A valid editing instruction can return a rejected decision or a question in a successful HTTP response.

| HTTP code name | Meaning |
|---|---|
| AUTH_REQUIRED | Supply an account or guest identity. |
| NOT_FOUND | The object is unavailable to this caller. |
| INVALID_REQUEST | Correct the request fields. |
| IDEMPOTENCY_CONFLICT | The same retry key already identifies different input. |
| TIMELINE_CONFLICT | Refresh the session before editing its newer revision. |
| TOO_MANY_REQUESTS | Wait before issuing another write. |
| JOB_PENDING | The requested result is still processing. |
| JOB_FAILED | Read the job details for the processing failure. |
| CALLBACK_NOT_ALLOWED | Use a callback destination configured by the operator. |
| PAYLOAD_TOO_LARGE | The submitted file exceeded the upload limit. |
| UNAVAILABLE | The service is starting or temporarily unavailable. |
| INTERNAL_ERROR | The service could not complete the request. |

Third-party software, model and media credits are in [SOURCES.md](SOURCES.md). Development assistance is recorded in [AI_USE.md](AI_USE.md).
