"""Latency histogram bucket aggregation and percentile estimator."""


class LatencyHistogram:
    """Aggregates task duration observations into upper-bound buckets."""

    def __init__(self, bounds_ms: tuple[float, ...] = (5.0, 25.0, 100.0, 500.0)) -> None:
        self.bounds_ms = bounds_ms
        self.counts = [0] * (len(bounds_ms) + 1)
        self.total = 0

    def observe(self, duration_ms: float) -> None:
        self.total += 1
        for idx, bound in enumerate(self.bounds_ms):
            if duration_ms <= bound:
                self.counts[idx] += 1
                return
        self.counts[-1] += 1

    def estimate_percentile(self, ratio: float) -> float:
        if self.total == 0:
            return 0.0
        target = self.total * ratio
        seen = 0
        for idx, bound in enumerate(self.bounds_ms):
            seen += self.counts[idx]
            if seen >= target:
                return bound
        return float("inf")
