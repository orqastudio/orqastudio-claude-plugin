---
id: SKILL-045
title: Rule Enforcement (CLI Plugin)
description: Understands how OrqaStudio governance rules are enforced in the Claude Code CLI via the companion plugin's PreToolUse hook.
status: active
created: "2026-03-11"
updated: "2026-03-11"
layer: plugin
scope: []
user-invocable: false
version: 0.1.0
---

# Rule Enforcement (CLI Plugin)

The OrqaStudio companion plugin brings the app's rule enforcement to Claude Code CLI via hooks.

## How It Works

Rules in `.orqa/governance/rules/RULE-NNN.md` can have an `enforcement` array in their YAML frontmatter. Each entry defines a pattern that is evaluated by the plugin's PreToolUse hook before tool calls execute.

## Enforcement Entry Format

```yaml
enforcement:
  - event: file
    pattern: "unwrap\\(\\)"
    paths: ["src-tauri/src/**/*.rs"]
    action: block
    message: "No unwrap() in production Rust code (RULE-006)."
```

## Event Types

| Event | Triggered By | Pattern Matched Against |
|-------|-------------|------------------------|
| `file` | Write, Edit tool calls | File content (new_string for Edit, content for Write) |
| `bash` | Bash tool calls | The command string |

## Actions

| Action | Behavior |
|--------|----------|
| `block` | Tool call is denied with the rule's message |
| `warn` | Tool call proceeds but the rule's message is shown as a warning |
| `inject` | Skills loaded into context as systemMessage (non-blocking) |

## Adding Enforcement to a Rule

1. Open the rule file in `.orqa/governance/rules/`
2. Add an `enforcement` array to the YAML frontmatter
3. Each entry needs: `event`, `action`, `message`
4. Optional: `pattern` (regex), `paths` (glob filters), `skills` (for inject action)
5. The plugin picks up changes on next session start
