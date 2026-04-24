// ============================================
// OpenSwarm - .env auto-loader
// ============================================
//
// Minimal, zero-dependency .env loader. Populates process.env with entries
// from the first .env file found, searching locations parallel to the config
// resolver. Existing process.env values are never overwritten — a shell
// export always wins over the file.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface EnvLoadResult {
  path: string | null;
  loadedKeys: string[];
}

function getSearchPaths(): string[] {
  const paths: string[] = [];

  // Explicit override wins.
  const override = process.env.OPENSWARM_ENV;
  if (override && override.length > 0) paths.push(override);

  // .env next to the config file, if one was explicitly pointed at.
  const configOverride = process.env.OPENSWARM_CONFIG;
  if (configOverride && configOverride.length > 0) {
    paths.push(join(dirname(configOverride), '.env'));
  }

  // Project-local (matches cwd-priority from findConfigFile).
  paths.push(join(process.cwd(), '.env'));

  const home = homedir();
  paths.push(join(home, '.config', 'openswarm', '.env'));
  paths.push(join(home, '.openswarm', '.env'));

  return paths;
}

/**
 * Parse a single line of a .env file. Returns [key, value] or null for
 * blank/comment lines. Supports KEY=value, KEY="value", KEY='value',
 * optional `export ` prefix, and basic backslash escapes (\n, \r, \t, \\, \")
 * inside double-quoted values.
 */
function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;

  const stripped = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
  const eq = stripped.indexOf('=');
  if (eq < 1) return null;

  const key = stripped.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = stripped.slice(eq + 1).trim();

  // Strip inline comments on unquoted values (but keep `#` inside quoted strings).
  if (value.length === 0) {
    return [key, ''];
  }

  const first = value[0];
  if (first === '"' || first === "'") {
    const end = value.lastIndexOf(first);
    if (end > 0) {
      let inner = value.slice(1, end);
      if (first === '"') {
        inner = inner
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      return [key, inner];
    }
    // Unterminated quote — fall through and treat raw.
  }

  const hash = value.indexOf(' #');
  if (hash >= 0) value = value.slice(0, hash).trimEnd();
  return [key, value];
}

/**
 * Load the first discovered .env file into process.env without overwriting
 * existing values. Returns the path loaded (or null) and the list of keys
 * that were newly applied — callers can log this for diagnostics.
 */
export function loadEnvFile(): EnvLoadResult {
  for (const path of getSearchPaths()) {
    if (!existsSync(path)) continue;

    const content = readFileSync(path, 'utf8');
    const loadedKeys: string[] = [];

    for (const rawLine of content.split(/\r?\n/)) {
      const parsed = parseLine(rawLine);
      if (parsed === null) continue;
      const [key, value] = parsed;
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      loadedKeys.push(key);
    }

    return { path, loadedKeys };
  }

  return { path: null, loadedKeys: [] };
}
