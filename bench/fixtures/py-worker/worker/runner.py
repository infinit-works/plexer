"""Main background worker execution loop."""

import json
import time

from .checkpoint import CheckpointStore
from .dedupe import DedupeCache
from .metrics import LatencyHistogram
from .scheduler import JobScheduler


class WorkerRunner:
    """Drains scheduled tasks, skips duplicates, and records checkpoints."""

    def __init__(self, state_dir: str) -> None:
        self.scheduler = JobScheduler()
        self.checkpoints = CheckpointStore(state_dir)
        self.dedupe = DedupeCache()
        self.histogram = LatencyHistogram()

    def process_due(self, worker_id: str, now_ts: float) -> int:
        processed = 0
        for task in self.scheduler.pop_due(now_ts):
            raw = json.dumps(task.payload, sort_keys=True).encode("utf-8")
            if not self.dedupe.claim(raw, now_ts):
                continue
            started = time.monotonic()
            self.checkpoints.save(worker_id, {"last_task": task.task_id})
            self.histogram.observe((time.monotonic() - started) * 1000.0)
            processed += 1
        return processed
