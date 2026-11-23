# EditMind integration API

The versioned service stores projects, sessions and asynchronous jobs in SQLite. Run one API process per data volume. The session endpoint branches from the project's current saved timeline and persists each submitted prompt, including clarification requests and rejected instructions. Render the session ID to export that branch. The browser’s unversioned compatibility API is separate.

The full contract is available at [openapi.yaml](../openapi.yaml) and through `GET /api/v1/openapi.yaml`. Paths below use the base `/api/v1`.

| Operation | Request | Result |
| --- | --- | --- |
| Upload and analyze | `POST /media/ingest` with multipart field `video` | HTTP 202 job ticket |
| Import and analyze | `POST /media/import-url` with a public HTTP(S) video URL | HTTP 202 job ticket |
| Poll | `GET /jobs/{id}` | Status, progress, project ID and result links |
| Analyze again | `POST /projects/{id}/retranscribe` | HTTP 202 job ticket |
| Open an editing branch | `POST /projects/{id}/sessions` with `{}` | HTTP 201 with session ID |
| Submit a step | `POST /sessions/{sid}/steps` with `say` and optional `expected_hash` | One typed editor response |
| Resume | `GET /sessions/{sid}` | Current timeline, hash, ordered response history |
| Hand off timeline | `GET /sessions/{sid}/timeline.otio` | OpenTimelineIO interchange document |
| Render MP4 | `POST /sessions/{sid}/render` or `POST /projects/{id}/exports` | HTTP 202 ticket for the snapshot at submission |
| Download results | Follow job result links to `/manifest` and `/download` | JSON provenance and MP4 |

Use a random private UUID for `x-guest-id` or present a signed-in account token in `Authorization: Bearer ...`. Supply the same credentials for every resource read and download. Reusing an `Idempotency-Key` with the original principal, path and input returns the original status and response. The service hashes multipart file content while writing it to disk. Duplicate checks and session changes share one SQLite transaction. Supply a fresh key for each new user action. The optional `expected_hash` protects against edits submitted against stale content.

The editor returns `applied`, `needs_clarification` or `rejected`. Submit a clarification reply to the same session. A render instruction returns a `RENDER` operation. Submit the separate render request to enqueue FFmpeg. A completed edit changes only the session branch. Ingest and render tickets progress through `queued`, `running` and either `succeeded` or `failed`. A partial or silent input can succeed with a warning in its manifest.

## Storage and callbacks

Compose starts a separate SeaweedFS S3-compatible service with a private network and persistent volume. Completed MP4s and success manifests use keys `results/{job_id}/edited.mp4` and `results/{job_id}/manifest.json`. Set `S3_BUCKET`, `S3_REGION` and, for a compatible service, `S3_ENDPOINT` to use a different store. Supply credentials through the AWS SDK identity chain. `S3_CREATE_BUCKET=1` permits first-run provisioning. With an empty bucket setting, local files and the SQLite manifest are used. The source, editor state and rendering workspace stay on the service volume.

For a completion callback, configure exact destinations in `CALLBACK_ALLOWED_URLS` and a private `CALLBACK_HMAC_SECRET`, then supply `callback_url` on the job request. The service POSTs the job status document. Verify `X-IncuBrix-Signature` against `sha256=` followed by the lowercase hex HMAC-SHA256 of the raw HTTP body. Redirects are disabled. The service attempts delivery three times and exposes `callback_status` when delivery ends. Deduplicate deliveries by job ID.

## Diagnostics

`GET /health` checks process liveness. `GET /ready` checks the database and configured S3 bucket. Both routes also support the versioned prefix. Supply `X-Correlation-Id` or read the generated ID in the response headers. Resource requests and job events emit JSON log entries with timestamp, level, correlation ID and job ID where applicable. Manifest costs use the configured `COMPUTE_USD_PER_HOUR` multiplied by elapsed wall time, including queue wait. Unconfigured costs are null and have a warning. Source rights and the AI-generated flag are supplied by the uploader.

| Code | Meaning |
| --- | --- |
| AUTH_REQUIRED | Supply valid account credentials or a guest capability |
| NOT_FOUND | Resource missing or outside this principal's scope |
| INVALID_REQUEST | Invalid input or unsupported render settings |
| IDEMPOTENCY_CONFLICT | A key already belongs to another request body |
| TIMELINE_CONFLICT | The expected revision differs from the current revision |
| TOO_MANY_REQUESTS | Write budget exhausted, retry after the response header interval |
| JOB_PENDING | The requested output is unavailable for this job |
| JOB_FAILED | The asynchronous job failed, see its status resource |
| CALLBACK_NOT_ALLOWED | The callback destination is outside the configured allowlist |
| PAYLOAD_TOO_LARGE | The request exceeds the configured limit |
| UNAVAILABLE | Readiness dependency unavailable |
| INTERNAL_ERROR | The service could not complete the operation |

