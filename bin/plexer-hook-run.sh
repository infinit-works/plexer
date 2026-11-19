#!/bin/sh
set -u

if [ $# -eq 0 ]; then
  printf '%s\n' "[plexer-hook] ERROR: missing script path" >&2
  exit 2
fi

if [ -n "${AGENT_HOOK_NODE:-}" ]; then
  node_bin="$AGENT_HOOK_NODE"
  explicit_override=1
  used_agent_node=0
elif [ -x "${XDG_DATA_HOME:-$HOME/.local/share}/agent-node/current/bin/node" ]; then
  node_bin="${XDG_DATA_HOME:-$HOME/.local/share}/agent-node/current/bin/node"
  explicit_override=0
  used_agent_node=1
else
  node_bin="node"
  explicit_override=0
  used_agent_node=0
fi

resolved="$(command -v "$node_bin" 2>/dev/null || true)"
if [ -n "$resolved" ]; then
  "$resolved" "$@"
  rc=$?
else
  rc=127
fi

if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
  if [ "$explicit_override" -eq 0 ] && [ "$used_agent_node" -eq 1 ]; then
    sys_node="$(command -v node 2>/dev/null || true)"
    if [ -n "$sys_node" ] && [ "$sys_node" != "$resolved" ]; then
      "$sys_node" "$@"
      rc=$?
    fi
  fi
  if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    event="${2:-hook}"
    printf '%s\n' "[plexer-hook] warning: node runtime failed to launch (exit $rc); failing open for $event" >&2
    case "$event" in
      agy-pre-tool|agy-stop|agy-post-cascade-response)
        printf '%s\n' '{"decision":"allow"}'
        ;;
      *)
        printf '%s\n' '{}'
        ;;
    esac
    exit 0
  fi
fi

exit "$rc"
