import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VerifyCommand } from './manifest.js';

const DEFAULT_TIMEOUT_MS = 300_000;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

function command(name: string, run: string, kind: VerifyCommand['kind']): VerifyCommand {
  return { name, run, kind, timeoutMs: DEFAULT_TIMEOUT_MS };
}

export async function discoverVerifyCommands(projectPath: string): Promise<VerifyCommand[]> {
  const commands: VerifyCommand[] = [];

  // Node/TypeScript: prefer repository scripts, then fall back to plain tsc.
  const packageSource = await readText(join(projectPath, 'package.json'));
  let scripts: Record<string, unknown> = {};
  if (packageSource) {
    try {
      const parsed = JSON.parse(packageSource) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) {
        scripts = parsed.scripts as Record<string, unknown>;
      }
    } catch {
      // An unreadable package manifest is not a discovery error; other ecosystems may still apply.
    }
  }
  if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) {
    commands.push(command('typecheck', 'npm run typecheck', 'typecheck'));
  } else if (await exists(join(projectPath, 'tsconfig.json'))) {
    commands.push(command('typecheck', 'npx tsc --noEmit', 'typecheck'));
  }
  if (
    typeof scripts.test === 'string'
    && scripts.test.trim()
    && !scripts.test.includes('Error: no test specified')
  ) {
    commands.push(command('test', 'npm run test', 'test'));
  }

  // Python: require an explicit pytest configuration signal.
  const pytestIni = await exists(join(projectPath, 'pytest.ini'));
  const pyproject = await readText(join(projectPath, 'pyproject.toml'));
  const setupCfg = await readText(join(projectPath, 'setup.cfg'));
  if (pytestIni || pyproject?.includes('[tool.pytest.ini_options]') || setupCfg?.includes('[tool:pytest]')) {
    commands.push(command('pytest', 'python -m pytest -x -q', 'test'));
  }

  // Rust repositories use Cargo's native test runner.
  if (await exists(join(projectPath, 'Cargo.toml'))) {
    commands.push(command('cargo test', 'cargo test --quiet', 'test'));
  }

  // Go repositories verify every package below the module root.
  if (await exists(join(projectPath, 'go.mod'))) {
    commands.push(command('go test', 'go test ./...', 'test'));
  }

  return commands;
}
