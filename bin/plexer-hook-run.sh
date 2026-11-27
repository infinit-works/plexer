#!/bin/sh
set -u

if [ $# -eq 0 ]; then
  printf '%s\n' "[plexer-hook] ERROR: missing script path" >&2
  exit 2
fi

event="${2:-hook}"

if [ "${PLEXER_DISABLE_HOOKS:-}" = "1" ]; then
  case "$event" in
    agy-pre-tool|agy-stop|agy-post-cascade-response)
      printf '%s\n' '{"decision":"allow"}'
      ;;
    *)
      printf '{}\n'
      ;;
  esac
  exit 0
fi

has_payload=0
payload=""
if [ "$event" = "agy-pre-tool" ] && [ -z "${PLEXER_TEST_STDIN+x}" ] && command -v jq >/dev/null 2>&1; then
  payload=$(cat)
  has_payload=1
  fast=$(printf '%s' "$payload" | jq -er '
    ((.toolCall.name // .tool_name // .toolName // "") | sub("^\\s+"; "") | sub("\\s+$"; "")) as $t |
    if $t == "" then
      "delegate"
    elif ($t | test("^(?:read_file|view_file|Read|read|run_command|Bash|run_shell_command|grep_search|Grep|find_by_name|Glob)$"; "i") | not) then
      "allow"
    elif ($t | test("^(?:run_command|Bash|run_shell_command)$"; "i")) then
      (.toolCall.args // .tool_input // .args // {}) as $a |
      ($a.CommandLine // $a.command // "") as $c |
      if ($c | type == "string") and (($c | test("(?:^|[\\s;/\\\\\"\u0027`])(?:plexer|cat|head|tail|sed|nl|e?grep|fgrep|rg|find)\\b|\\bgit\\s+(?:grep|diff|log)\\b")) | not) then
        "allow"
      else
        "delegate"
      end
    else
      "delegate"
    end
  ' 2>/dev/null) || fast="delegate"
  if [ "$fast" = "allow" ]; then
    printf '%s\n' '{"decision":"allow"}'
    exit 0
  fi
fi

if [ -n "${AGENT_HOOK_NODE:-}" ]; then
  if [ -x "$AGENT_HOOK_NODE" ]; then
    if [ "$has_payload" -eq 1 ]; then
      printf '%s' "$payload" | "$AGENT_HOOK_NODE" "$@"
      exit $?
    else
      exec "$AGENT_HOOK_NODE" "$@"
    fi
  fi
  node_bin="$AGENT_HOOK_NODE"
  explicit_override=1
  used_agent_node=0
elif [ -x "${XDG_DATA_HOME:-$HOME/.local/share}/agent-node/current/bin/node" ]; then
  agent_node="${XDG_DATA_HOME:-$HOME/.local/share}/agent-node/current/bin/node"
  if [ "$has_payload" -eq 1 ]; then
    printf '%s' "$payload" | "$agent_node" "$@"
    exit $?
  else
    exec "$agent_node" "$@"
  fi
else
  node_bin="node"
  explicit_override=0
  used_agent_node=0
fi

resolved="$(command -v "$node_bin" 2>/dev/null || true)"
if [ -n "$resolved" ]; then
  if [ "$has_payload" -eq 1 ]; then
    printf '%s' "$payload" | "$resolved" "$@"
  else
    "$resolved" "$@"
  fi
  rc=$?
else
  rc=127
fi

if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
  if [ "$explicit_override" -eq 0 ] && [ "$used_agent_node" -eq 1 ]; then
    sys_node="$(command -v node 2>/dev/null || true)"
    if [ -n "$sys_node" ] && [ "$sys_node" != "$resolved" ]; then
      if [ "$has_payload" -eq 1 ]; then
        printf '%s' "$payload" | "$sys_node" "$@"
      else
        "$sys_node" "$@"
      fi
      rc=$?
    fi
  fi
  if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
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
