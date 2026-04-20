import { basename } from "node:path";

import type { CommandMatchSource, ToolExecutionInput } from "../types.js";

export type CommandMatchCandidate = {
  command: string;
  argv: string[];
  source: CommandMatchSource;
};

const FILE_CONTENT_INSPECTION_COMMANDS = new Set(["cat", "sed", "head", "tail", "nl", "bat", "batcat", "jq", "yq"]);
const REPO_INVENTORY_COMMANDS = new Set(["find", "fd", "fdfind", "ls", "tree"]);
const SETUP_WRAPPER_COMMANDS = new Set(["cd", "pwd", "set", "source", ".", "export", "unset", "trap"]);
const SHELL_RUNNER_COMMANDS = new Set(["bash", "sh", "zsh"]);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/u;

function getNormalizedArgv(input: Pick<ToolExecutionInput, "argv" | "command">): string[] {
  if (input.argv?.length) {
    return input.argv;
  }
  if (!input.command) {
    return [];
  }
  return tokenizeCommand(input.command);
}

function getCommandText(input: Pick<ToolExecutionInput, "argv" | "command">): string {
  if (typeof input.command === "string") {
    return input.command.trim();
  }
  return getNormalizedArgv(input).join(" ");
}

function getNormalizedArgv0(argv: string[]): string | null {
  const first = argv[0];
  if (!first) {
    return null;
  }
  return basename(first.replace(/^["']|["']$/gu, ""));
}

function getSourcePriority(source: CommandMatchSource): number {
  switch (source) {
    case "effective":
      return 2;
    case "shell-body":
      return 1;
    case "original":
    default:
      return 0;
  }
}

function isFileContentInspectionArgv(argv: string[]): boolean {
  const argv0 = getNormalizedArgv0(argv);
  if (!argv0) {
    return false;
  }
  return FILE_CONTENT_INSPECTION_COMMANDS.has(argv0);
}

function isRepositoryInspectionArgv(argv: string[]): boolean {
  const argv0 = getNormalizedArgv0(argv);
  if (!argv0) {
    return false;
  }
  if (isFileContentInspectionArgv(argv)) {
    return true;
  }
  if (REPO_INVENTORY_COMMANDS.has(argv0)) {
    return true;
  }
  if (argv0 === "rg" && argv.includes("--files")) {
    return true;
  }
  if (argv0 === "git" && argv[1] === "ls-files") {
    return true;
  }
  return false;
}

function buildCandidate(
  input: Pick<ToolExecutionInput, "argv" | "command">,
  source: CommandMatchSource,
): CommandMatchCandidate {
  const argv = getNormalizedArgv(input);
  return {
    command: getCommandText(input),
    argv,
    source,
  };
}

function dedupeCandidates(candidates: CommandMatchCandidate[]): CommandMatchCandidate[] {
  const deduped: CommandMatchCandidate[] = [];
  const indexes = new Map<string, number>();

  for (const candidate of candidates) {
    const key = `${candidate.command.trim()}\0${candidate.argv.join("\0")}`;
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, deduped.length);
      deduped.push(candidate);
      continue;
    }

    const existing = deduped[existingIndex]!;
    if (getSourcePriority(candidate.source) > getSourcePriority(existing.source)) {
      deduped[existingIndex] = candidate;
    }
  }

  return deduped;
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function splitTopLevelCommandChain(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    return [];
  }

  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaping = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      current += char;
      quote = char;
      continue;
    }

    if (char === "&" && trimmed[index + 1] === "&") {
      const segment = current.trim();
      if (segment) {
        segments.push(segment);
      }
      current = "";
      index += 1;
      continue;
    }

    if (char === ";" || char === "\n") {
      const segment = current.trim();
      if (segment) {
        segments.push(segment);
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (quote || escaping) {
    return [trimmed];
  }

  const segment = current.trim();
  if (segment) {
    segments.push(segment);
  }

  return segments;
}

export function unwrapShellRunner(input: Pick<ToolExecutionInput, "argv" | "command">): string | null {
  const argv = getNormalizedArgv(input);
  const argv0 = getNormalizedArgv0(argv);
  if (!argv0 || !SHELL_RUNNER_COMMANDS.has(argv0)) {
    return null;
  }

  for (let index = 1; index < argv.length - 1; index += 1) {
    if (argv[index] === "-c" || argv[index] === "-lc") {
      const shellBody = argv[index + 1]?.trim();
      return shellBody ? shellBody : null;
    }
  }

  return null;
}

export function stripLeadingEnvAssignments(argv: string[]): string[] {
  let index = 0;
  while (index < argv.length && ENV_ASSIGNMENT_PATTERN.test(argv[index] ?? "")) {
    index += 1;
  }
  return argv.slice(index);
}

export function isSetupWrapperSegment(argv: string[]): boolean {
  const stripped = stripLeadingEnvAssignments(argv);
  if (stripped.length === 0) {
    return true;
  }

  const argv0 = getNormalizedArgv0(stripped);
  if (!argv0) {
    return true;
  }

  return SETUP_WRAPPER_COMMANDS.has(argv0);
}

export function resolveEffectiveCommand(input: Pick<ToolExecutionInput, "argv" | "command">): CommandMatchCandidate | null {
  const command = getCommandText(input);
  const argv = getNormalizedArgv(input);

  if (!command && argv.length === 0) {
    return null;
  }

  if (!command) {
    const strippedArgv = stripLeadingEnvAssignments(argv);
    if (strippedArgv.length === 0 || isSetupWrapperSegment(strippedArgv)) {
      return null;
    }
    if (strippedArgv.length === argv.length) {
      return null;
    }
    return {
      command: strippedArgv.join(" "),
      argv: strippedArgv,
      source: "effective",
    };
  }

  const segments = splitTopLevelCommandChain(command);
  let sawTransformation = segments.length > 1;

  for (const segment of segments) {
    const segmentArgv = tokenizeCommand(segment);
    if (segmentArgv.length === 0) {
      continue;
    }

    const strippedArgv = stripLeadingEnvAssignments(segmentArgv);
    if (strippedArgv.length !== segmentArgv.length) {
      sawTransformation = true;
    }

    if (strippedArgv.length === 0) {
      sawTransformation = true;
      continue;
    }

    if (isSetupWrapperSegment(strippedArgv)) {
      sawTransformation = true;
      continue;
    }

    if (!sawTransformation) {
      return null;
    }

    return {
      command: strippedArgv.join(" "),
      argv: strippedArgv,
      source: "effective",
    };
  }

  return null;
}

export function deriveCommandMatchCandidates(
  input: Pick<ToolExecutionInput, "argv" | "command">,
): CommandMatchCandidate[] {
  const candidates: CommandMatchCandidate[] = [buildCandidate(input, "original")];

  const shellBody = unwrapShellRunner(input);
  if (shellBody) {
    candidates.push(buildCandidate({ command: shellBody }, "shell-body"));
  }

  const effective = resolveEffectiveCommand(shellBody ? { command: shellBody } : input);
  if (effective) {
    candidates.push(effective);
  }

  return dedupeCandidates(candidates);
}

function getMostDerivedCandidate(input: Pick<ToolExecutionInput, "argv" | "command">): CommandMatchCandidate {
  return deriveCommandMatchCandidates(input).reduce((best, candidate) => (
    getSourcePriority(candidate.source) >= getSourcePriority(best.source) ? candidate : best
  ));
}

export function isCompoundShellCommand(command: string): boolean {
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (char === ";" || char === "\n" || char === "|") {
      return true;
    }

    if ((char === "&" || char === "|") && command[index + 1] === char) {
      return true;
    }
  }

  return false;
}

export function isFileContentInspectionCommand(input: Pick<ToolExecutionInput, "argv" | "command">): boolean {
  return isFileContentInspectionArgv(getMostDerivedCandidate(input).argv);
}

export function isRepositoryInspectionCommand(input: Pick<ToolExecutionInput, "argv" | "command">): boolean {
  return isRepositoryInspectionArgv(getMostDerivedCandidate(input).argv);
}

export function normalizeCommandSignature(command?: string): string | null {
  if (!command || command === "stdin" || command.startsWith("reduce:")) {
    return null;
  }

  const argv = getNormalizedArgv({ command });
  if (argv.length === 0) {
    return null;
  }

  const normalized = getNormalizedArgv0(argv);
  return normalized || null;
}

export function normalizeEffectiveCommandSignature(command?: string): string | null {
  if (!command || command === "stdin" || command.startsWith("reduce:")) {
    return null;
  }

  const candidate = getMostDerivedCandidate({ command });
  const normalized = getNormalizedArgv0(candidate.argv);
  return normalized || null;
}

export function normalizeExecutionInput(input: ToolExecutionInput): ToolExecutionInput {
  if (input.argv?.length || !input.command) {
    return input;
  }

  const argv = tokenizeCommand(input.command);
  if (argv.length === 0) {
    return input;
  }

  return {
    ...input,
    argv,
  };
}
