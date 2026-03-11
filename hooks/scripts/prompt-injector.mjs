#!/usr/bin/env node
// Prompt-based skill injector: examines user prompt, classifies intent,
// and injects relevant domain skills as systemMessage.
//
// Used by UserPromptSubmit hook. Reads hook input from stdin.
// Outputs JSON with systemMessage containing skill content.
//
// Intent classification currently uses keyword heuristics. Designed for
// easy upgrade to AI classification (Haiku model call) when API access
// is available in the hook context.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// Intent-to-skill mapping table
// Each entry: { keywords: string[], skills: string[], description: string }
const INTENT_MAP = [
  {
    keywords: ["tauri command", "ipc", "invoke", "#[tauri::command]", "add a command", "new command"],
    skills: ["orqa-ipc-patterns", "orqa-error-composition"],
    description: "IPC boundary work",
  },
  {
    keywords: ["store", "reactive", "$state", "$derived", "$effect", "rune"],
    skills: ["orqa-store-patterns", "orqa-store-orchestration"],
    description: "Store architecture",
  },
  {
    keywords: ["component", "svelte component", "ui component", "create a component"],
    skills: ["component-extraction", "svelte5-best-practices"],
    description: "Component work",
  },
  {
    keywords: ["domain", "domain service", "domain model", "business logic"],
    skills: ["orqa-domain-services", "orqa-error-composition"],
    description: "Domain logic",
  },
  {
    keywords: ["repository", "database", "sqlite", "migration", "query"],
    skills: ["orqa-repository-pattern"],
    description: "Data access layer",
  },
  {
    keywords: ["stream", "sidecar", "ndjson", "provider", "streaming"],
    skills: ["orqa-streaming"],
    description: "Streaming pipeline",
  },
  {
    keywords: ["plan", "approach", "design", "architect", "tradeoff"],
    skills: ["planning", "architecture", "systems-thinking"],
    description: "Planning phase",
  },
  {
    keywords: ["review", "check", "audit", "verify", "quality"],
    skills: ["code-quality-review", "qa-verification"],
    description: "Review phase",
  },
  {
    keywords: ["debug", "fix", "broken", "error", "failing", "crash", "bug"],
    skills: ["diagnostic-methodology", "systems-thinking"],
    description: "Diagnostic work",
  },
  {
    keywords: ["test", "testing", "vitest", "cargo test", "coverage"],
    skills: ["orqa-testing", "test-engineering"],
    description: "Testing work",
  },
  {
    keywords: ["search", "find", "where is", "locate"],
    skills: ["orqa-code-search"],
    description: "Code search",
  },
  {
    keywords: ["governance", "rule", "skill", "artifact", "enforcement"],
    skills: ["orqa-governance", "orqa-documentation"],
    description: "Governance work",
  },
  {
    keywords: ["refactor", "restructur", "reorganiz", "extract", "consolidat"],
    skills: ["restructuring-methodology", "systems-thinking"],
    description: "Refactoring work",
  },
];

// Classify intent from user prompt using keyword matching
// Returns array of unique skill names to inject
function classifyIntent(prompt) {
  const lower = prompt.toLowerCase();
  const matchedSkills = new Set();

  for (const entry of INTENT_MAP) {
    const matches = entry.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (matches) {
      for (const skill of entry.skills) {
        matchedSkills.add(skill);
      }
    }
  }

  return [...matchedSkills];
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

// Read skill files, deduplicating against already-injected
function collectSkillContent(projectDir, skillNames) {
  const alreadyInjected = readInjectedSkills(projectDir);
  const alreadySet = new Set(alreadyInjected);

  // Filter to only new skills
  const newSkills = skillNames.filter((name) => !alreadySet.has(name));
  if (newSkills.length === 0) return null;

  const parts = [];
  const injectedNow = [];

  for (const name of newSkills) {
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

  const userMessage = hookInput.user_message || hookInput.prompt || "";
  const projectDir = hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || ".";

  if (!userMessage) {
    process.exit(0);
  }

  // Classify intent and determine which skills to inject
  const skillNames = classifyIntent(userMessage);
  if (skillNames.length === 0) {
    process.exit(0);
  }

  // Read and deduplicate skill content
  const skillContent = collectSkillContent(projectDir, skillNames);
  if (!skillContent) {
    process.exit(0);
  }

  // Return skill content as systemMessage
  const output = JSON.stringify({
    systemMessage: skillContent,
  });
  process.stdout.write(output);
  process.exit(0);
}

main().catch(() => process.exit(0));
