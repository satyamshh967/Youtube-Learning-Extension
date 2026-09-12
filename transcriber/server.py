from pathlib import Path
import shutil
import tempfile

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://.*",
    allow_methods=["*"],
    allow_headers=["*"],
)

model = WhisperModel(
    "base",
    device="cpu",
    compute_type="int8",
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
):
    suffix = (
        Path(file.filename or "").suffix
        or ".webm"
    )

    with tempfile.NamedTemporaryFile(
        suffix=suffix,
        delete=False,
    ) as temp_file:
        temp_path = Path(temp_file.name)

        with temp_file:
            shutil.copyfileobj(
                file.file,
                temp_file,
            )

    try:
        segments, info = model.transcribe(
            str(temp_path),
            beam_size=5,
            vad_filter=True,
        )

        transcript = [
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
            }
            for segment in segments
            if segment.text.strip()
        ]

        return {
            "language": info.language,
            "languageProbability": (
                info.language_probability
            ),
            "segments": transcript,
        }
    finally:
        temp_path.unlink(
            missing_ok=True,
        )