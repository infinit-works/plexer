# Python Worker Pipeline

Background workers schedule cron jobs via `JobScheduler`, deduplicate repeated
payloads, persist crash-safe checkpoints, and track percentile latency buckets.

## Graceful Shutdown

On `SIGTERM`, the runner finishes active in-flight handlers and flushes final
checkpoint cursors before closing the process pool.
