"""Measure deployed edit latency and repeat-session determinism on real, analyzed projects.

python scripts/measure-session-latency.py --base-url https://HOST --output evidence/latency.json \
    --project five-minute=/private/five.json --project sixty-minute=/private/hour.json
Each private JSON file contains "guest" (owner capability) and "pid" (project ID).
Only aggregate media metadata, prompts, timings, response codes, and hashes are saved.
Requires requests. A benchmark creates fresh editing sessions, leaving the source project intact.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
from statistics import median
import time
import uuid
from urllib.parse import urlsplit

import requests


STEPS = [
    ("Cut the first 3 seconds", "applied"),
    ("Add caption \"Review copy\" at 0:15 for 2 seconds", "applied"),
    ("Speed up from 0:40 to 0:55 by 2x", "applied"),
    ("Mute 25 to 27", "applied"),
    ("Add background music", "applied"),
    ("Put the intro back", "applied"),
    ("Undo", "applied"),
    ("Redo", "applied"),
    ("Make that caption red", "applied"),
    ("Cut the boring part", "needs_clarification"),
    ("Cancel", "applied"),
    ("Speed up 10x", "rejected"),
]


def post(client, url, payload):
    start = time.perf_counter_ns()
    reply = client.post(url, headers={"Idempotency-Key": str(uuid.uuid4())}, json=payload, timeout=45)
    elapsed_ms = (time.perf_counter_ns() - start) / 1e6
    if not reply.ok:
        try:
            code = reply.json()["error"]["code"]
        except (ValueError, KeyError, TypeError):
            code = "HTTP_ERROR"
        raise RuntimeError(f"HTTP {reply.status_code} {code}")
    return reply.json(), round(elapsed_ms, 2)


def bench(base, path, label, repeats):
    private = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    with requests.Session() as client:
        client.headers.update({"x-guest-id": private["guest"]})
        runs = []
        for _ in range(repeats):
            new, setup_ms = post(client, base + "/projects/" + private["pid"] + "/sessions", {})
            url = base + "/sessions/" + new["session_id"] + "/steps"
            rows = []
            for say, expected in STEPS:
                result, elapsed_ms = post(client, url, {"say": say})
                rows.append({"instruction": say, "expected_status": expected, "status": result["status"],
                             "code": result["code"], "timeline_hash": result["timeline_hash"],
                             "duration_s": result["duration_s"], "elapsed_ms": elapsed_ms})
            runs.append({"setup_ms_excluded": setup_ms, "steps": rows})
    times = [item["elapsed_ms"] for run in runs for item in run["steps"]]
    signatures = [[(item["status"], item["timeline_hash"]) for item in run["steps"]] for run in runs]
    return {"label": label, "source_duration_s": new["duration_s"], "runs": runs, "step_count": len(times),
            "median_ms": round(median(times), 2), "slowest_ms": max(times), "all_under_3s": max(times) < 3000,
            "all_statuses_expected": all(row["status"] == row["expected_status"] for run in runs for row in run["steps"]),
            "identical_across_runs": all(sig == signatures[0] for sig in signatures)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Origin serving /api/v1")
    parser.add_argument("--project", action="append", required=True, help="LABEL=private fixture credential path")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    origin = urlsplit(args.base_url)
    if origin.username or origin.password or origin.query or origin.fragment or origin.path not in ("", "/"):
        parser.error("Supply an origin without a path or credentials")
    if args.repeats < 1:
        parser.error("At least one run is required")
    report = {"schema_version": 1, "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "base_origin": args.base_url.rstrip("/"), "measurement": "Client wall clock over a reused HTTP connection; complete response body included. Session setup, transcription and render excluded.",
              "projects": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for spec in args.project:
        label, private_path = spec.split("=", 1)
        measured = bench(args.base_url.rstrip("/") + "/api/v1", private_path, label, args.repeats)
        report["projects"].append(measured)
        temporary = args.output.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, args.output)
        print(label, measured["step_count"], "steps; median", measured["median_ms"],
              "ms; slowest", measured["slowest_ms"], "ms; deterministic", measured["identical_across_runs"], flush=True)
    if not all(p["identical_across_runs"] and p["all_statuses_expected"] for p in report["projects"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
