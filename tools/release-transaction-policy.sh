#!/usr/bin/env bash

# Returns the only safe recovery action after an interrupted update.
# Arguments: rollback_armed, process_committed, durable_journal_state.
mb_update_failure_action() {
  local rollback_armed="$1"
  local process_committed="$2"
  local journal_state="$3"

  if [[ "$rollback_armed" == "true" &&
        "$process_committed" != "true" &&
        ( "$journal_state" == "uncommitted" || "$journal_state" == "absent" ) ]]; then
    printf '%s\n' rollback
    return 0
  fi
  if [[ "$process_committed" == "true" || "$journal_state" == "committed" ]]; then
    printf '%s\n' forward-repair
    return 0
  fi
  if [[ "$rollback_armed" == "true" ]]; then
    printf '%s\n' manual
    return 0
  fi
  printf '%s\n' none
}
