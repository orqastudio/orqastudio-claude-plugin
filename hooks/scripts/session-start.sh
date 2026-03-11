#!/usr/bin/env bash
# OrqaStudio plugin — SessionStart hook
# Sets up .claude/ symlinks and runs session health checks

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
ORQA_DIR="$PROJECT_DIR/.orqa"
CLAUDE_DIR="$PROJECT_DIR/.claude"

# ─── Symlink Setup ───────────────────────────────────────────────────────────
# The plugin manages all .claude/ symlinks. .orqa/ is the single source of truth.
# These symlinks are required by Claude Code's native discovery:
#   CLAUDE.md  — project instructions (from orchestrator agent)
#   rules/     — rules loaded as system context
#   agents/    — agent definitions for subagent delegation
#   skills/    — skill definitions for /skill commands

create_symlink() {
  local link="$1"
  local target="$2"

  # Detect OS for symlink creation
  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "mingw"* || "$OSTYPE" == "cygwin" ]]; then
    # Windows — use PowerShell for proper NTFS symlinks
    local win_link
    local win_target
    win_link=$(cygpath -w "$link" 2>/dev/null || echo "$link")
    win_target=$(cygpath -w "$target" 2>/dev/null || echo "$target")

    if [ -d "$target" ]; then
      powershell -Command "New-Item -ItemType SymbolicLink -Path '$win_link' -Target '$win_target' -Force" > /dev/null 2>&1
    else
      powershell -Command "New-Item -ItemType SymbolicLink -Path '$win_link' -Target '$win_target' -Force" > /dev/null 2>&1
    fi
  else
    # Unix — standard ln -sfn
    ln -sfn "$target" "$link"
  fi
}

setup_symlink() {
  local link="$1"
  local target="$2"

  # Skip if .orqa/ source doesn't exist
  if [ ! -e "$target" ]; then
    return
  fi

  # Already a correct symlink
  if [ -L "$link" ]; then
    return
  fi

  # Real file/dir exists — don't overwrite
  if [ -e "$link" ]; then
    return
  fi

  create_symlink "$link" "$target"
}

if [ -d "$ORQA_DIR" ]; then
  mkdir -p "$CLAUDE_DIR"

  # .claude/ symlinks — required by Claude Code's native discovery
  setup_symlink "$CLAUDE_DIR/CLAUDE.md" "$ORQA_DIR/team/agents/orchestrator.md"
  setup_symlink "$CLAUDE_DIR/rules"     "$ORQA_DIR/governance/rules"
  setup_symlink "$CLAUDE_DIR/agents"    "$ORQA_DIR/team/agents"
  setup_symlink "$CLAUDE_DIR/skills"    "$ORQA_DIR/team/skills"
fi

# ─── Plugin Skill Installation ──────────────────────────────────────────────
# Symlink plugin skills into .orqa/team/skills/ so they're discoverable by
# the artifact scanner and browsable in the app. Plugin skills have layer: plugin.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"

if [ -n "$PLUGIN_ROOT" ] && [ -d "$PLUGIN_ROOT/skills" ] && [ -d "$ORQA_DIR/team/skills" ]; then
  for skill_dir in "$PLUGIN_ROOT"/skills/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    target_dir="$ORQA_DIR/team/skills/$skill_name"
    setup_symlink "$target_dir" "$skill_dir"
  done
fi

# ─── Session Guard ───────────────────────────────────────────────────────────
# Only run health checks once per session
GUARD="$PROJECT_DIR/tmp/.session-started"
if [ -f "$GUARD" ]; then
  exit 0
fi
mkdir -p "$PROJECT_DIR/tmp"
touch "$GUARD"

# ─── Health Checks ───────────────────────────────────────────────────────────
OUTPUT=""

# Check for stashes
STASHES=$(cd "$PROJECT_DIR" && git stash list 2>/dev/null || true)
if [ -n "$STASHES" ]; then
  OUTPUT="${OUTPUT}WARNING: Git stashes found! Investigate and commit before proceeding:\n${STASHES}\n\n"
fi

# Check for stale worktrees
MAIN_DIR=$(cd "$PROJECT_DIR" && git rev-parse --show-toplevel 2>/dev/null || echo "$PROJECT_DIR")
WORKTREES=$(cd "$PROJECT_DIR" && git worktree list 2>/dev/null | grep -v "$MAIN_DIR" || true)
if [ -n "$WORKTREES" ]; then
  OUTPUT="${OUTPUT}WARNING: Non-main worktrees detected! Check if these need cleanup:\n${WORKTREES}\n\n"
fi

# Check for orphaned worktree directories
PARENT_DIR=$(dirname "$MAIN_DIR")
ORPHANS=$(ls -d "$PARENT_DIR"/orqa-* 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  OUTPUT="${OUTPUT}WARNING: Orphaned worktree directories found:\n${ORPHANS}\n\n"
fi

# Check for uncommitted changes on main
CURRENT_BRANCH=$(cd "$PROJECT_DIR" && git branch --show-current 2>/dev/null || true)
if [ "$CURRENT_BRANCH" = "main" ]; then
  UNCOMMITTED=$(cd "$PROJECT_DIR" && git status --short 2>/dev/null | wc -l | tr -d ' ')
  if [ "$UNCOMMITTED" -gt 20 ]; then
    OUTPUT="${OUTPUT}WARNING: ${UNCOMMITTED} uncommitted files on main! Commit before starting new work.\n\n"
  elif [ "$UNCOMMITTED" -gt 0 ]; then
    OUTPUT="${OUTPUT}NOTE: ${UNCOMMITTED} uncommitted files on main. Consider committing before starting new work.\n\n"
  fi
fi

# Check for session state from previous session
if [ -f "$PROJECT_DIR/tmp/session-state.md" ]; then
  SESSION_STATE=$(cat "$PROJECT_DIR/tmp/session-state.md")
  OUTPUT="${OUTPUT}PREVIOUS SESSION STATE FOUND:\n${SESSION_STATE}\n\n"
fi

# Dogfood detection
if [ -f "$ORQA_DIR/project.json" ]; then
  if grep -q '"dogfood"[[:space:]]*:[[:space:]]*true' "$ORQA_DIR/project.json" 2>/dev/null; then
    OUTPUT="${OUTPUT}DOGFOOD MODE ACTIVE: You are editing the app from the CLI.\n"
    OUTPUT="${OUTPUT}- CLI context: make restart does NOT end the session\n"
    OUTPUT="${OUTPUT}- Use make restart-tauri after Rust changes\n"
    OUTPUT="${OUTPUT}- See RULE-009 for full dogfood rules\n\n"
  fi
fi

# Delegation reminder
OUTPUT="${OUTPUT}ORCHESTRATOR REMINDERS:\n"
OUTPUT="${OUTPUT}- You coordinate. You do NOT implement. Delegate to specialized agents.\n"
OUTPUT="${OUTPUT}- Universal roles: researcher, planner, implementer, reviewer, writer, designer\n"
OUTPUT="${OUTPUT}- Roles are specialised via skills at runtime\n\n"

OUTPUT="${OUTPUT}SESSION START CHECKLIST:\n"
OUTPUT="${OUTPUT}- Check .orqa/planning/tasks/ for current tasks\n"
OUTPUT="${OUTPUT}- Check .orqa/planning/epics/ for active epics\n"

if [ -n "$OUTPUT" ]; then
  echo -e "$OUTPUT"
fi

exit 0
