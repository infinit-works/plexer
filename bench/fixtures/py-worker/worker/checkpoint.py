"""Atomic crash-recovery checkpoint persistence."""

import json
import os
from pathlib import Path


class CheckpointStore:
    """Flushes worker progress atomically using temp file write and os.replace."""

    def __init__(self, state_dir: str) -> None:
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)

    def save(self, worker_id: str, cursor: dict) -> Path:
        target = self.state_dir / f"{worker_id}.json"
        staging = self.state_dir / f".{worker_id}.{os.getpid()}.tmp"
        staging.write_text(json.dumps(cursor, sort_keys=True), encoding="utf-8")
        os.replace(staging, target)
        return target

    def load(self, worker_id: str) -> dict:
        target = self.state_dir / f"{worker_id}.json"
        if not target.exists():
            return {"offset": 0}
        return json.loads(target.read_text(encoding="utf-8"))
