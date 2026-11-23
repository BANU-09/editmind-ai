# The EditMind timeline

A saved project describes one source recording. Its ordered `segments` array is the playback sequence. Each segment keeps a stable source reference, original in- and out-points, playback speed and gain. Positions use seconds and ranges are half-open. The first playback segment starts at zero. Each subsequent segment starts when its predecessor ends. Playback duration is the sum of the retained source intervals divided by their respective speeds. The engine accumulates durations before rounding displayed positions to the nearest millisecond.

**Time and content references.** In a session, “1:20” always denotes 80 seconds into the original recording. The response repeats this policy and states the duration before and after the edit. A cut point inside a measured silence stays exactly where the user specified, including when recognition stretches a word across that silence. Elsewhere, source cuts expand to full intersected words and can snap to a measured silence boundary up to 80 ms away. The engine uses transcript words and source timestamps. Precision therefore depends on the transcript's word alignment. A clip with a variable frame rate uses its media timestamps.

**Captions and audio.** A spoken caption stores the contributing words and their source intervals. Custom display text is independent of the phrase used to locate it. Preview and export intersect those original intervals with each surviving segment in playback order. A partial cut keeps only surviving spoken text in an automatic caption. A custom caption keeps its author's wording while any anchored words remain. Removing all anchors hides the caption and produces a warning. Restoring the footage makes the caption visible again. Accelerated captions extend toward a 0.7-second reading interval where room remains before the next caption or end of the video. Muting, bleeping and custom overlays retain source intervals and follow those intervals when footage moves. Background music uses the edited playback clock and lowers its gain under speech.

**Revisions.** Each accepted change appends one event with concrete operations. A multi-action instruction is checked on a temporary state and committed together. Undo and redo move one event at a time. A new change after undo starts a new branch. A selective restore records which earlier event to suppress and replays the remaining concrete operations from the initial project. Explicitly protected pauses survive automatic silence removal. A later speed instruction replaces earlier speed values within the selected overlap. Repeating an already satisfied instruction leaves the history cursor and timeline hash unchanged.

**Interchange and validation.** The project schema is [timeline.schema.json](../schemas/timeline.schema.json). Ordered clips, media references, markers and speed effects are also available as OpenTimelineIO JSON. Each clip stores its real source end and playback speed under `metadata.editmind`. Captions, mute and bleep markers carry original anchors. The EditMind MP4 renderer applies caption styles, bleeps and music. Third-party editors decide how to display or interpret custom marker metadata.

Validate a saved timeline and its OTIO counterpart with the official OpenTimelineIO adapter:

```sh
python -m pip install opentimelineio==0.18.1 jsonschema==4.26.0
python scripts/verify-timeline.py timeline.json timeline.otio
```

The verifier checks the schema, continuous playback intervals, retime arithmetic, media references, both track durations and a serialization round-trip. The OTIO file refers to the original recording by filename. Place a copy of that recording next to the OTIO file, or relink it in your editor. The project's authenticated source download provides the original bytes. To validate an entire runner output directory and write per-session hashes, use `python scripts/verify-timeline.py --pack OUTPUTS --report evidence/otio-validation.json`.
