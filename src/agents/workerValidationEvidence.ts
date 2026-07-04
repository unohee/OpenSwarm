import type { WorkerResult } from './agentPair.js';

const VALIDATION_RELEVANT_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|c|cc|cpp|h|hpp|swift|kt|kts|scala|cs|php|sh|bash|zsh|sql|toml|ya?ml|json)$/i;
const VALIDATION_RELEVANT_BASENAME_RE = /(^|\/)(Dockerfile(?:\.[^/]+)?|Containerfile(?:\.[^/]+)?|Makefile|GNUmakefile|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|package(?:-lock)?\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|requirements(?:-[^/]+)?\.txt|pyproject\.toml|poetry\.lock|Pipfile(?:\.lock)?|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|flake\.nix|shell\.nix|docker-compose\.ya?ml|compose\.ya?ml)$/i;
const DOC_ONLY_FILE_RE = /(^|\/)(README|CHANGELOG|LICENSE|NOTICE)(\.[^./]+)?$|(^|\/)docs?\/|\.((md|mdx|txt|rst|adoc))$/i;
const VALIDATION_COMMAND_RE = /\b(npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|pnpm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|yarn\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|bun\s+(?:test|run\s+(?:test|build|lint|typecheck|check|ci|verify|validate|smoke))|vitest|jest|mocha|pytest|ruff|mypy|pyright|tsc|eslint|oxlint|cargo\s+(?:check|test|clippy|build)|go\s+(?:test|vet|build)|swift\s+test|gradle\s+(?:test|build|check)|mvn\s+(?:test|verify)|make\b|cmake\b|py_compile|compileall|clippy|fmt\s+--check)\b/i;
const INSPECTION_ONLY_COMMAND_RE = /^\s*(?:cd\b.*?(?:&&|;)\s*)?(?:rg|grep|sed|cat|ls|find|pwd|git\s+(?:status|diff|show|log|grep)|jq|head|tail|wc|tree|du|file|which)\b/i;
const SCRIPT_SMOKE_COMMAND_RE = /^\s*(?:cd\b.*?(?:&&|;)\s*)?(?:python3?|node|tsx|ts-node|uv\s+run|npx|bunx|bash|sh)\b.*\b(?:scripts?\/|tests?\/|\.py|\.js|\.ts|\.sh|--help|--dry-run|smoke|verify|validate|check|test|build|compile)\b/i;
const TESTER_CODE_FILE_RE = /\.(ts|tsx|js|jsx|py|rs|go|java|rb|c|cpp|h|hpp)$/;

function validationRelevantFiles(files: string[]): string[] {
  return files.filter(file => {
    if (/(^|\/)docs?\//i.test(file)) return false;
    if (VALIDATION_RELEVANT_BASENAME_RE.test(file)) return true;
    return VALIDATION_RELEVANT_FILE_RE.test(file) && !DOC_ONLY_FILE_RE.test(file);
  });
}

function commandLooksLikeValidation(command: string): boolean {
  if (INSPECTION_ONLY_COMMAND_RE.test(command)) return false;
  if (VALIDATION_COMMAND_RE.test(command)) return true;
  return SCRIPT_SMOKE_COMMAND_RE.test(command);
}

export function missingWorkerValidationIssues(result: WorkerResult): string[] {
  const changed = validationRelevantFiles(result.filesChanged ?? []);
  if (changed.length === 0) return [];
  const commands = result.commands ?? [];
  if (commands.some(commandLooksLikeValidation)) return [];

  const sample = changed.slice(0, 6).join(', ');
  const suffix = changed.length > 6 ? `, +${changed.length - 6} more` : '';
  const commandIssue = commands.length === 0
    ? 'Worker changed code/config files but reported zero validation commands.'
    : `Worker changed code/config files but only reported non-validation commands: ${commands.slice(0, 3).join('; ')}`;
  return [
    commandIssue,
    `Run at least one relevant smoke/build/test/static check before review, or run the closest available check and report its failure. Files needing validation: ${sample}${suffix}`,
  ];
}

export function testerWouldRunForWorkerResult(
  result: WorkerResult,
  hasTester: boolean,
  skipIfNoCode: boolean
): boolean {
  if (!hasTester) return false;
  if (!skipIfNoCode) return true;
  return (result.filesChanged ?? []).some(file => TESTER_CODE_FILE_RE.test(file));
}

export function isTesterCodeFile(file: string): boolean {
  return TESTER_CODE_FILE_RE.test(file);
}
