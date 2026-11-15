"""Priority-heap cron task scheduler for background workers."""

import heapq
from dataclasses import dataclass, field


@dataclass(order=True)
class ScheduledTask:
    run_at: float
    priority: int
    task_id: str = field(compare=False)
    payload: dict = field(compare=False)


class JobScheduler:
    """Orders pending cron tasks on a min-heap by next run time and priority."""

    def __init__(self) -> None:
        self._heap: list[ScheduledTask] = []

    def schedule(self, task_id: str, run_at: float, priority: int, payload: dict) -> None:
        heapq.heappush(self._heap, ScheduledTask(run_at, priority, task_id, payload))

    def pop_due(self, now_ts: float) -> list[ScheduledTask]:
        ready: list[ScheduledTask] = []
        while self._heap and self._heap[0].run_at <= now_ts:
            ready.append(heapq.heappop(self._heap))
        return ready

    def pending_count(self) -> int:
        return len(self._heap)
