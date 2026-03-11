---
name: Rule Enforcement
description: Understands how OrqaStudio governance rules are mechanically enforced via the companion plugin.
layer: plugin
user-invocable: false
version: 0.1.0
---

# Rule Enforcement

The OrqaStudio companion plugin enforces governance rules mechanically via Claude Code hooks.

## How It Works

Rules in `.orqa/governance/rules/RULE-NNN.md` can have an `enforcement` array in their YAML frontmatter. Each entry defines a pattern that is evaluated by the plugin's PreToolUse hook before tool calls execute.

## Enforcement Entry Format

```yaml
enforcement:
  - event: file          # "file" or "bash"
    pattern: "unwrap\\(\\)"  # regex pattern to match
    paths: ["src-tauri/src/**/*.rs"]  # optional glob filter
    action: block        # "block" or "warn"
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

## Currently Enforced Rules

- **RULE-006** (coding-standards): Blocks `unwrap()`, `expect()`, `panic!()` in Rust production code
- **RULE-007** (development-commands): Warns on raw cargo/npm commands instead of make targets
- **RULE-013** (git-workflow): Blocks `--no-verify`, warns on destructive git operations
- **RULE-020** (no-stubs): Warns on TODO/FIXME/HACK/XXX comments in production code

## Adding Enforcement to a Rule

1. Open the rule file in `.orqa/governance/rules/`
2. Add an `enforcement` array to the YAML frontmatter
3. Each entry needs: `event`, `pattern`, `action`, `message`
4. Optional: `paths` array of glob patterns to restrict file matching
5. The plugin picks up changes on next session start
