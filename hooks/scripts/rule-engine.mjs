#!/usr/bin/env node
// Rule engine: loads active rules with enforcement entries, evaluates patterns
// against tool call context. Used by PreToolUse hook.
//
// Reads hook input from stdin (JSON with tool_name, tool_input).
// Outputs JSON for Claude Code hook system.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Unescape YAML double-quoted string escapes
function yamlUnescape(str) {
  return str.replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
}

// Simple YAML frontmatter parser (no external deps)
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result = {};

  // Parse simple key: value pairs
  let currentKey = null;
  let currentObj = null;
  let inArray = false;
  let inObjArray = false;

  for (const line of yaml.split("\n")) {
    // Top-level key with simple value
    const simpleMatch = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (simpleMatch && !inObjArray) {
      currentKey = simpleMatch[1];
      let val = simpleMatch[2].trim();
      // Handle quoted strings
      if (val.startsWith('"') && val.endsWith('"')) val = yamlUnescape(val.slice(1, -1));
      // Handle inline arrays [a, b]
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""));
      }
      result[currentKey] = val;
      inArray = false;
      inObjArray = false;
      continue;
    }

    // Top-level key with no value (start of array or object)
    const keyOnly = line.match(/^(\w[\w-]*)\s*:\s*$/);
    if (keyOnly) {
      currentKey = keyOnly[1];
      result[currentKey] = [];
      inArray = true;
      inObjArray = false;
      continue;
    }

    // Array item (start of object) — check BEFORE simple string
    if (inArray && line.match(/^  -\s+\w+\s*:/)) {
      inObjArray = true;
      currentObj = {};
      const objMatch = line.match(/^  -\s+(\w+)\s*:\s*(.*)$/);
      if (objMatch) {
        let val = objMatch[2].trim();
        if (val.startsWith('"') && val.endsWith('"')) val = yamlUnescape(val.slice(1, -1));
        currentObj[objMatch[1]] = val;
      }
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(currentObj);
      continue;
    }

    // Array item (simple string) — after object check
    if (inArray && !inObjArray && line.match(/^  -\s/)) {
      const val = line.replace(/^  -\s+/, "").trim();
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(val);
      continue;
    }

    // Object property within array item
    if (inObjArray && currentObj && line.match(/^    \w+:/)) {
      const propMatch = line.match(/^    (\w+)\s*:\s*(.*)$/);
      if (propMatch) {
        let val = propMatch[2].trim();
        if (val.startsWith('"') && val.endsWith('"')) val = yamlUnescape(val.slice(1, -1));
        // Handle inline arrays
        if (val.startsWith("[") && val.endsWith("]")) {
          val = val
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim().replace(/^"|"$/g, ""));
        }
        currentObj[propMatch[1]] = val;
      }
    }
  }

  return result;
}

// Check if a file path matches a glob pattern
function matchGlob(filePath, pattern) {
  // Normalize separators
  const normalized = filePath.replace(/\\/g, "/");
  // Convert glob to regex
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{DOUBLESTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
  return new RegExp(regex).test(normalized);
}

// Load all active rules with enforcement entries
function loadEnforcementRules(projectDir) {
  const rulesDir = join(projectDir, ".orqa", "governance", "rules");
  if (!existsSync(rulesDir)) return [];

  const rules = [];
  for (const file of readdirSync(rulesDir)) {
    if (!file.startsWith("RULE-") || !file.endsWith(".md")) continue;

    const content = readFileSync(join(rulesDir, file), "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    if (fm.status && fm.status !== "active") continue;
    if (!fm.enforcement || !Array.isArray(fm.enforcement)) continue;

    for (const entry of fm.enforcement) {
      rules.push({
        ruleId: fm.id || file.replace(".md", ""),
        event: entry.event,
        pattern: entry.pattern,
        paths: entry.paths || null,
        action: entry.action,
        message: entry.message,
        skills: entry.skills || null,
      });
    }
  }
  return rules;
}

// Evaluate enforcement rules against a tool call
function evaluate(rules, toolName, toolInput) {
  const violations = [];

  for (const rule of rules) {
    let matched = false;

    if (rule.event === "file" && (toolName === "Write" || toolName === "Edit")) {
      // Get file path and content from tool input
      const filePath = toolInput.file_path || "";
      const content =
        toolName === "Write"
          ? toolInput.content || ""
          : toolInput.new_string || "";

      // Check path filter
      if (rule.paths) {
        const pathList = Array.isArray(rule.paths)
          ? rule.paths
          : [rule.paths];
        const pathMatches = pathList.some((p) => matchGlob(filePath, p));
        if (!pathMatches) continue;
      }

      // Check content pattern
      try {
        const regex = new RegExp(rule.pattern);
        if (regex.test(content)) {
          matched = true;
        }
      } catch {
        // Invalid regex, skip
      }
    }

    if (rule.event === "bash" && toolName === "Bash") {
      const command = toolInput.command || "";
      try {
        const regex = new RegExp(rule.pattern);
        if (regex.test(command)) {
          matched = true;
        }
      } catch {
        // Invalid regex, skip
      }
    }

    if (matched) {
      violations.push({
        ruleId: rule.ruleId,
        action: rule.action,
        message: rule.message,
        skills: rule.skills,
      });
    }
  }

  return violations;
}

// Read the session-level injected skills state
function readInjectedSkills(projectDir) {
  const stateFile = join(projectDir, "tmp", ".injected-skills.json");
  if (!existsSync(stateFile)) return [];
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return [];
  }
}

// Write the session-level injected skills state
function writeInjectedSkills(projectDir, skills) {
  const tmpDir = join(projectDir, "tmp");
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }
  writeFileSync(join(tmpDir, ".injected-skills.json"), JSON.stringify(skills));
}

// Strip YAML frontmatter from skill content
function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  if (match) return match[1].trim();
  return content.trim();
}

// Read skill content for injection, deduplicating against already-injected skills
function collectSkillContent(projectDir, injectViolations) {
  const alreadyInjected = readInjectedSkills(projectDir);
  const alreadySet = new Set(alreadyInjected);

  // Gather all unique skill names from all inject violations
  const allSkillNames = [];
  for (const v of injectViolations) {
    if (!v.skills) continue;
    const skillList = Array.isArray(v.skills) ? v.skills : [v.skills];
    for (const name of skillList) {
      if (!alreadySet.has(name) && !allSkillNames.includes(name)) {
        allSkillNames.push(name);
      }
    }
  }

  if (allSkillNames.length === 0) return null;

  // Read skill files
  const parts = [];
  const injectedNow = [];
  for (const name of allSkillNames) {
    const skillPath = join(projectDir, ".orqa", "team", "skills", name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const raw = readFileSync(skillPath, "utf-8");
      const content = stripFrontmatter(raw);
      if (content) {
        parts.push(content);
        injectedNow.push(name);
      }
    } catch {
      // Skip unreadable files silently
    }
  }

  if (parts.length === 0) return null;

  // Persist updated state
  writeInjectedSkills(projectDir, [...alreadyInjected, ...injectedNow]);

  return parts.join("\n\n---\n\n");
}

// Main
async function main() {
  // Read stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookInput;
  try {
    hookInput = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = hookInput.tool_name || "";
  const toolInput = hookInput.tool_input || {};
  const projectDir = hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || ".";

  // Only evaluate for Write, Edit, and Bash tools
  if (!["Write", "Edit", "Bash"].includes(toolName)) {
    process.exit(0);
  }

  const rules = loadEnforcementRules(projectDir);
  const violations = evaluate(rules, toolName, toolInput);

  if (violations.length === 0) {
    process.exit(0);
  }

  // Separate violations by action
  const blockViolations = violations.filter((v) => v.action === "block");
  const warnViolations = violations.filter((v) => v.action === "warn");
  const injectViolations = violations.filter((v) => v.action === "inject");

  // Collect skill content for inject entries (with session dedup)
  const skillContent = injectViolations.length > 0
    ? collectSkillContent(projectDir, injectViolations)
    : null;

  // Determine overall action: block > warn > inject-only
  const hasBlock = blockViolations.length > 0;
  const hasWarn = warnViolations.length > 0;

  if (hasBlock) {
    // Blocking: deny the tool call
    const messages = [...blockViolations, ...warnViolations].map(
      (v) => `[${v.ruleId}] ${v.message}`
    );
    const combinedMessage = [
      ...messages,
      ...(skillContent ? [skillContent] : []),
    ].join("\n");

    const output = JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
      systemMessage: combinedMessage,
    });
    process.stderr.write(output);
    process.exit(2);
  } else if (hasWarn || skillContent) {
    // Non-blocking: warn and/or inject skills
    const messages = warnViolations.map((v) => `[${v.ruleId}] ${v.message}`);
    const combinedMessage = [
      ...messages,
      ...(skillContent ? [skillContent] : []),
    ].join("\n");

    const output = JSON.stringify({
      systemMessage: combinedMessage,
    });
    process.stdout.write(output);
    process.exit(0);
  } else {
    // Inject entries had no new skills to inject (all already injected)
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
