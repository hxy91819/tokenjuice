import { deriveCommandMatchCandidates, type CommandMatchCandidate } from "./command.js";

import type { ClassificationResult, CompiledRule, JsonRule, ToolExecutionInput } from "../types.js";

function includesAll(argv: string[], expected: string[]): boolean {
  return expected.every((part) => argv.includes(part));
}

type RuleLike = JsonRule | CompiledRule;

type RuleMatchSelection<T extends RuleLike> = {
  rule: T;
  candidate: CommandMatchCandidate;
};

function getJsonRule(rule: RuleLike): JsonRule {
  return "rule" in rule ? rule.rule : rule;
}

function getCandidatePriority(candidate: CommandMatchCandidate): number {
  switch (candidate.source) {
    case "effective":
      return 2;
    case "shell-body":
      return 1;
    case "original":
    default:
      return 0;
  }
}

function buildCandidateInput(input: ToolExecutionInput, candidate: CommandMatchCandidate): ToolExecutionInput {
  return {
    ...input,
    command: candidate.command,
    argv: candidate.argv,
  };
}

export function matchesRule(ruleLike: RuleLike, input: ToolExecutionInput): boolean {
  const rule = getJsonRule(ruleLike);
  const argv = input.argv ?? [];
  const command = input.command ?? "";
  const toolName = input.toolName;

  if (rule.match.toolNames && !rule.match.toolNames.includes(toolName)) {
    return false;
  }

  if (rule.match.argv0 && !rule.match.argv0.includes(argv[0] ?? "")) {
    return false;
  }

  if (rule.match.argvIncludes && !rule.match.argvIncludes.every((parts) => includesAll(argv, parts))) {
    return false;
  }

  if (rule.match.argvIncludesAny && !rule.match.argvIncludesAny.some((parts) => includesAll(argv, parts))) {
    return false;
  }

  if (rule.match.commandIncludes && !rule.match.commandIncludes.every((part) => command.includes(part))) {
    return false;
  }

  if (rule.match.commandIncludesAny && !rule.match.commandIncludesAny.some((part) => command.includes(part))) {
    return false;
  }

  return true;
}

function scoreRule(ruleLike: RuleLike): number {
  const rule = getJsonRule(ruleLike);
  return (
    (rule.priority ?? 0) * 1000
    + (rule.match.argv0?.length ?? 0) * 100
    + (rule.match.argvIncludes?.reduce((sum, parts) => sum + parts.length, 0) ?? 0) * 40
    + (rule.match.argvIncludesAny?.reduce((sum, parts) => sum + parts.length, 0) ?? 0) * 35
    + (rule.match.commandIncludes?.length ?? 0) * 25
    + (rule.match.commandIncludesAny?.length ?? 0) * 20
    + (rule.match.toolNames?.length ?? 0) * 10
  );
}

function compareSelections(left: RuleMatchSelection<RuleLike>, right: RuleMatchSelection<RuleLike>): number {
  const scoreDiff = scoreRule(right.rule) - scoreRule(left.rule);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const candidateDiff = getCandidatePriority(right.candidate) - getCandidatePriority(left.candidate);
  if (candidateDiff !== 0) {
    return candidateDiff;
  }

  return getJsonRule(left.rule).id.localeCompare(getJsonRule(right.rule).id);
}

export function findBestRuleMatch<T extends RuleLike>(
  input: ToolExecutionInput,
  rules: T[],
): RuleMatchSelection<T> | undefined {
  const candidates = deriveCommandMatchCandidates(input);
  const specificMatches: Array<RuleMatchSelection<T>> = [];
  let fallbackSelection: RuleMatchSelection<T> | undefined;

  for (const candidate of candidates) {
    const candidateInput = buildCandidateInput(input, candidate);

    for (const rule of rules) {
      if (!matchesRule(rule, candidateInput)) {
        continue;
      }

      if (getJsonRule(rule).id === "generic/fallback") {
        fallbackSelection ??= { rule, candidate };
        continue;
      }

      specificMatches.push({ rule, candidate });
    }
  }

  if (specificMatches.length > 0) {
    return [...specificMatches].sort(compareSelections)[0];
  }

  return fallbackSelection;
}

function buildClassificationResult(
  ruleLike: RuleLike,
  candidate: CommandMatchCandidate,
): ClassificationResult {
  const rule = getJsonRule(ruleLike);
  return {
    family: rule.family,
    confidence: rule.id === "generic/fallback" ? 0.2 : 0.9,
    matchedReducer: rule.id,
    matchedVia: candidate.source,
    matchedCommand: candidate.command,
  };
}

export function classifyExecution(
  input: ToolExecutionInput,
  rules: RuleLike[],
  forcedRuleId?: string,
): ClassificationResult {
  if (forcedRuleId) {
    const forcedRule = rules.find((rule) => getJsonRule(rule).id === forcedRuleId);
    if (forcedRule) {
      const forced = getJsonRule(forcedRule);
      return {
        family: forced.family,
        confidence: 1,
        matchedReducer: forced.id,
      };
    }
  }

  const match = findBestRuleMatch(input, rules);
  if (!match) {
    return {
      family: "generic",
      confidence: 0.2,
    };
  }

  return buildClassificationResult(match.rule, match.candidate);
}
