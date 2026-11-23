"""Regenerate the public two-minute spoken fixture using Python and FFmpeg with Flite."""
import argparse
from pathlib import Path
import subprocess
import tempfile
import wave


LINES = [
    (2, "slt", "This is a recording from our little editing studio."),
    (10, "rms", "Thanks for joining us today."),
    (17, "slt", "What is your favorite part of the project?"),
    (25, "rms", "I like the library. It is open every evening."),
    (34, "slt", "Our pricing changed last spring. The basic plan costs ten dollars."),
    (42, "slt", "Welcome to the channel."),
    (52, "rms", "Our pricing includes the camera and a microphone."),
    (63, "slt", "Thanks for describing the studio."),
    (71, "rms", "My old company made cameras. I worked there for five years."),
    (81, "slt", "Thanks for the explanation. Let us turn to the library."),
    (94, "rms", "The final pricing option covers delivery and the lights."),
    (106, "slt", "Thanks again. See you at the studio next week."),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--seconds", type=int, default=120)
    args = parser.parse_args()
    if args.seconds < 115:
        parser.error("Use at least 115 seconds to fit every line.")
    args.output = args.output.resolve()
    args.output.parent.mkdir(exist_ok=True, parents=True)
    rate = 16000
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        track = bytearray(rate * 2 * args.seconds)
        for start, voice, line in LINES:
            (directory / "line.txt").write_text(line, encoding="ascii")
            subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                            f"flite=textfile=line.txt:voice={voice}", "-ar", str(rate),
                            "-ac", "1", "-c:a", "pcm_s16le", "line.wav"], cwd=tmp, check=True)
            with wave.open(str(directory / "line.wav")) as wav:
                samples = wav.readframes(wav.getnframes())
            for offset in range(start, args.seconds, 120):
                i = offset * rate * 2
                chunk = samples[:len(track) - i]
                track[i:i + len(chunk)] = chunk
        with wave.open(str(directory / "studio.wav"), "wb") as wav:
            wav.setparams((1, 2, rate, 0, "NONE", ""))
            wav.writeframes(track)
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                        "color=c=0x284450:size=320x180:rate=15",
                        "-i", "studio.wav", "-t", str(args.seconds), "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k",
                        "-movflags", "+faststart", str(args.output)], cwd=tmp, check=True)


if __name__ == "__main__":
    main()
