# Service Architecture Runbook

## Request Lifecycle & Auth

Incoming API requests pass through tenant throttling before hitting ledger handlers.
Bearer tokens are checked against the active key ring with a 30s clock skew window.

## Idempotency Keys & Ledger Safety

Every mutating billing call must supply an `idempotencyKey`. Repeated submissions
with the same key return the stored ledger record instead of issuing duplicate charges.

## Circuit Breaker Fallback Behavior

When downstream webhook sinks exceed consecutive timeout thresholds, the gateway
opens the circuit breaker for 60 seconds and routes events directly to dead-letter
storage rather than blocking synchronous invoice settlement.
