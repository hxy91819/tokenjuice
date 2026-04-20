import { describe, expect, it } from "vitest";

import {
  deriveCommandMatchCandidates,
  isFileContentInspectionCommand,
  isRepositoryInspectionCommand,
  normalizeCommandSignature,
  normalizeEffectiveCommandSignature,
  normalizeExecutionInput,
  resolveEffectiveCommand,
  splitTopLevelCommandChain,
  tokenizeCommand,
  unwrapShellRunner,
} from "../src/core/command.js";

describe("tokenizeCommand", () => {
  it("keeps quoted path arguments together", () => {
    expect(tokenizeCommand("sed -n '1,80p' 'src/rules/search/rg.json'")).toEqual([
      "sed",
      "-n",
      "1,80p",
      "src/rules/search/rg.json",
    ]);
  });
});

describe("splitTopLevelCommandChain", () => {
  it("splits top-level setup and command segments", () => {
    expect(splitTopLevelCommandChain("cd apps && swift test")).toEqual([
      "cd apps",
      "swift test",
    ]);
  });

  it("does not split quoted separators", () => {
    expect(splitTopLevelCommandChain("bash -lc 'echo \"a && b\"; swift test'")).toEqual([
      "bash -lc 'echo \"a && b\"; swift test'",
    ]);
  });
});

describe("unwrapShellRunner", () => {
  it("extracts a shell body from bash -lc", () => {
    expect(unwrapShellRunner({ command: "bash -lc 'cd apps && swift test'" })).toBe("cd apps && swift test");
  });
});

describe("resolveEffectiveCommand", () => {
  it("skips leading setup segments and chooses the first substantive command", () => {
    expect(resolveEffectiveCommand({ command: "cd repo && swift test && rg failure src" })).toEqual({
      command: "swift test",
      argv: ["swift", "test"],
      source: "effective",
    });
  });

  it("strips env assignments before matching", () => {
    expect(resolveEffectiveCommand({ command: "FOO='a b' swift build" })).toEqual({
      command: "swift build",
      argv: ["swift", "build"],
      source: "effective",
    });
  });

  it("returns null when every segment is setup-only", () => {
    expect(resolveEffectiveCommand({ command: "export FOO=1 && export BAR=2" })).toBeNull();
  });

  it("returns null for already-direct commands", () => {
    expect(resolveEffectiveCommand({ command: "pnpm test" })).toBeNull();
  });
});

describe("deriveCommandMatchCandidates", () => {
  it("derives original, shell-body, and effective candidates for wrapped shell commands", () => {
    expect(deriveCommandMatchCandidates({ command: "bash -lc 'cd repo && pnpm test'" })).toEqual([
      {
        command: "bash -lc 'cd repo && pnpm test'",
        argv: ["bash", "-lc", "cd repo && pnpm test"],
        source: "original",
      },
      {
        command: "cd repo && pnpm test",
        argv: ["cd", "repo", "&&", "pnpm", "test"],
        source: "shell-body",
      },
      {
        command: "pnpm test",
        argv: ["pnpm", "test"],
        source: "effective",
      },
    ]);
  });

  it("keeps the shell-body candidate when it already represents the effective command", () => {
    expect(deriveCommandMatchCandidates({ command: "bash -lc 'pnpm test'" })).toEqual([
      {
        command: "bash -lc 'pnpm test'",
        argv: ["bash", "-lc", "pnpm test"],
        source: "original",
      },
      {
        command: "pnpm test",
        argv: ["pnpm", "test"],
        source: "shell-body",
      },
    ]);
  });
});

describe("normalizeCommandSignature", () => {
  it("normalizes quoted executable paths", () => {
    expect(normalizeCommandSignature("\"/opt/homebrew/bin/tokenjuice\" wrap --raw -- rg --files")).toBe("tokenjuice");
  });
});

describe("normalizeEffectiveCommandSignature", () => {
  it("normalizes wrapped effective commands without changing raw signature semantics", () => {
    expect(normalizeEffectiveCommandSignature("cd apps && swift test")).toBe("swift");
    expect(normalizeEffectiveCommandSignature("bash -lc 'pnpm test'")).toBe("pnpm");
  });
});

describe("normalizeExecutionInput", () => {
  it("derives argv from command text when argv is missing", () => {
    expect(normalizeExecutionInput({
      toolName: "exec",
      command: "find src -maxdepth 2 -type f",
    }).argv).toEqual(["find", "src", "-maxdepth", "2", "-type", "f"]);
  });
});

describe("isFileContentInspectionCommand", () => {
  it.each([
    { label: "cat", command: "cat README.md" },
    { label: "sed", command: "sed -n '1,80p' src/core/reduce.ts" },
    { label: "head", command: "head -n 20 package.json" },
    { label: "tail", command: "tail -n 20 pnpm-lock.yaml" },
    { label: "nl", command: "nl -ba src/core/codex.ts" },
    { label: "bat", command: "bat README.md" },
    { label: "jq", command: "jq '.version' package.json" },
    { label: "yq", command: "yq '.name' pnpm-workspace.yaml" },
    { label: "wrapped cat", command: "cd repo && cat README.md" },
  ])("detects $label as file inspection from command text", ({ command }) => {
    expect(isFileContentInspectionCommand({ command })).toBe(true);
  });

  it("returns false for normal search commands", () => {
    expect(isFileContentInspectionCommand({ command: "rg AssertionError src" })).toBe(false);
  });
});

describe("isRepositoryInspectionCommand", () => {
  it.each([
    "cat README.md",
    "find src/rules -maxdepth 2 -type f",
    "fd codex src",
    "fdfind codex src",
    "ls src/rules",
    "tree src/rules",
    "rg --files src/rules",
    "git ls-files src",
    "pwd && rg --files src/rules",
  ])("detects `%s` as repository inspection", (command) => {
    expect(isRepositoryInspectionCommand({ command })).toBe(true);
  });

  it.each([
    "rg AssertionError src",
    "git status --short",
    "pnpm test",
    "pwd && rg -n AssertionError src",
  ])("does not over-match `%s`", (command) => {
    expect(isRepositoryInspectionCommand({ command })).toBe(false);
  });
});
