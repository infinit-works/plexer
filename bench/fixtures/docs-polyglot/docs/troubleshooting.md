# Diagnostic Troubleshooting Playbook

## Pipe EOF Errors

Unexpected `EOF` on the worker IPC stream usually indicates a crashed child
process or a partial frame written without the 4-byte big-endian length header.
Capture the last frame offset and restart the bridge with clean pipe buffers.

## Stale Locks & Timeout Spikes

When a worker exits uncleanly, remove orphaned session lock files older than
the heartbeat grace period and verify upstream connection pool saturation is
below the concurrency cap before retrying requests.
