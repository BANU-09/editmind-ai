"""Validate exported EditMind state and read its .otio review file with the official adapter.

Usage: python scripts/verify-timeline.py timeline.json timeline.otio
       python scripts/verify-timeline.py --pack OUTPUTS --report evidence/otio-validation.json
Requires jsonschema and opentimelineio.
"""
import argparse
import hashlib
import json
import math
from importlib.metadata import version
from pathlib import Path

import jsonschema
import opentimelineio as otio


def verify(state_path, otio_path):
    state = json.loads(Path(state_path).read_text(encoding="utf-8-sig"))
    schema_path = Path(__file__).resolve().parents[1] / "schemas" / "timeline.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.Draft202012Validator(schema).validate(state)

    total = 0.0
    for segment in state["segments"]:
        assert segment["sourceEnd"] > segment["sourceStart"], "Invalid source interval"
        assert math.isclose(total, segment["timelineStart"], abs_tol=.0011), "Timeline has a gap or overlap"
        total += (segment["sourceEnd"] - segment["sourceStart"]) / segment["speed"]
        assert math.isclose(total, segment["timelineEnd"], abs_tol=.0011), "Incorrect edit duration"
    assert math.isclose(total, state["duration"], abs_tol=.0011)

    timeline = otio.adapters.read_from_file(otio_path)
    restored = otio.adapters.read_from_string(otio.adapters.write_to_string(timeline))
    for item in [timeline, restored]:
        assert math.isclose(item.duration().to_seconds(), state["duration"], abs_tol=.0011)
        clip_count = 0
        for track in item.tracks:
            assert len(track) == len(state["segments"])
            for clip, segment in zip(track, state["segments"]):
                assert clip.media_reference.target_url
                assert math.isclose(clip.metadata["editmind"]["source_end"], segment["sourceEnd"])
                assert math.isclose(clip.source_range.start_time.to_seconds(), segment["sourceStart"], abs_tol=.0011)
                if segment["speed"] != 1:
                    assert any(isinstance(e, otio.schema.LinearTimeWarp) and
                               math.isclose(e.time_scalar, segment["speed"]) for e in clip.effects)
                clip_count += 1
    print(f"Validated timeline schema, source ranges and OTIO round-trip: {clip_count} clips, {total:.3f} seconds.")
    return {"session": Path(state_path).parent.name, "duration_s": state["duration"], "tracks": len(timeline.tracks),
            "clips": clip_count, "timeline_hash": timeline.metadata["editmind"]["timeline_hash"],
            "timeline_file_sha256": hashlib.sha256(Path(state_path).read_bytes()).hexdigest(),
            "otio_file_sha256": hashlib.sha256(Path(otio_path).read_bytes()).hexdigest(), "result": "passed"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*")
    parser.add_argument("--pack", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.pack:
        files = sorted(args.pack.glob("*/timeline.otio"))
        if not files or args.files:
            parser.error("Specify one non-empty session output directory")
        pairs = [(f.with_name("timeline.json"), str(f)) for f in files]
    elif len(args.files) == 2:
        pairs = [args.files]
    else:
        parser.error("Specify an EditMind JSON timeline and its OTIO file")
    results = [verify(state, native) for state, native in pairs]
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        report = {"opentimelineio": version("opentimelineio"), "jsonschema": version("jsonschema"), "sessions": results}
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
