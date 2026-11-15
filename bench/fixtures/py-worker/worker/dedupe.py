"""Payload deduplication filter backed by SHA-256 digests and TTL eviction."""

import hashlib
import time


class DedupeCache:
    """Rejects duplicate incoming payloads within a configurable expiration TTL."""

    def __init__(self, ttl_seconds: float = 300.0) -> None:
        self.ttl_seconds = ttl_seconds
        self._seen: dict[str, float] = {}

    def digest_payload(self, body: bytes) -> str:
        return hashlib.sha256(body).hexdigest()

    def evict_expired(self, now_ts: float | None = None) -> int:
        cutoff = (now_ts if now_ts is not None else time.monotonic()) - self.ttl_seconds
        stale = [key for key, ts in self._seen.items() if ts <= cutoff]
        for key in stale:
            del self._seen[key]
        return len(stale)

    def claim(self, body: bytes, now_ts: float | None = None) -> bool:
        ts = now_ts if now_ts is not None else time.monotonic()
        self.evict_expired(ts)
        key = self.digest_payload(body)
        if key in self._seen:
            return False
        self._seen[key] = ts
        return True
