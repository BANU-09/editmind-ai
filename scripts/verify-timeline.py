"""Validate exported EditMind state and read its .otio review file with the official adapter.

Usage: python scripts/verify-timeline.py timeline.json timeline.otio
Requires jsonschema and opentimelineio.
"""
import json
import math
import sys
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


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    verify(sys.argv[1], sys.argv[2])
