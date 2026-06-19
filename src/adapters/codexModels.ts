// ============================================
// OpenSwarm - Codex model discovery
// ============================================
//
// Ports the hermes-agent `codex_models.py` pattern: discover the Codex models
// an account can actually use, via the OAuth-backed Codex backend, with offline
// fallbacks. Resolution order:
//   1. live API (chatgpt.com Codex backend) — when an access token is provided
//   2. ~/.codex/config.toml default `model`
//   3. ~/.codex/models_cache.json (the Codex CLI's own cache)
//   4. curated hardcoded fallback
// Clawdbot-style forward-compat synthetic slugs are layered on top so a newer
// model surfaces whenever an older compatible template is present.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_MODELS_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Curated fallback, used only when live discovery is unavailable (offline first
 * run, transient API failure). `gpt-5-codex` is OpenSwarm's proven default and
 * stays first; the remaining GPT-5.x slugs mirror the Codex OAuth backend
 * catalog. Slugs the backend rejects with HTTP 400 on ChatGPT accounts
 * (gpt-5.2-codex / gpt-5.1-codex-max / gpt-5.1-codex-mini, verified dead in
 * hermes) are deliberately excluded so the picker never leaks a model selection
 * will reject. Live discovery (the primary path when authenticated) overrides
 * this list entirely.
 */
export const DEFAULT_CODEX_MODELS: string[] = [
  'gpt-5-codex',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  // Research-preview, exposed only via the Codex OAuth backend for ChatGPT Pro.
  // The backend reports supported_in_api:false for this slug — that flag is
  // about the public OpenAI API, not the Codex backend, so it is NOT filtered.
  'gpt-5.3-codex-spark',
];

/**
 * Surface a newer synthetic slug whenever a compatible older template model is
 * present (mirrors Clawdbot's forward-compat catalog for GPT-5 Codex variants).
 */
const FORWARD_COMPAT_TEMPLATES: Array<[synthetic: string, templates: string[]]> = [
  ['gpt-5.5', ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex']],
  ['gpt-5.4-mini', ['gpt-5.3-codex']],
  ['gpt-5.4', ['gpt-5.3-codex']],
  ['gpt-5.3-codex-spark', ['gpt-5.3-codex']],
];

/** De-dupe (order-preserving) then append synthetic forward-compat slugs. */
export function addForwardCompatModels(modelIds: string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of modelIds) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }

  for (const [synthetic, templates] of FORWARD_COMPAT_TEMPLATES) {
    if (seen.has(synthetic)) continue;
    if (templates.some((tpl) => seen.has(tpl))) {
      ordered.push(synthetic);
      seen.add(synthetic);
    }
  }

  return ordered;
}

interface CodexModelEntry {
  slug?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

/** Parse the Codex backend `models` array → slugs sorted by priority. */
function parseModelEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];

  const sortable: Array<[rank: number, slug: string]> = [];
  for (const item of entries as CodexModelEntry[]) {
    if (!item || typeof item !== 'object') continue;
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (!slug) continue;
    // Do NOT filter on `supported_in_api`: it describes the public OpenAI API,
    // while this provider talks to the same OAuth-backed Codex backend as the
    // Codex CLI (valid slugs like gpt-5.3-codex-spark are marked false there).
    const visibility = typeof item.visibility === 'string' ? item.visibility.trim().toLowerCase() : '';
    if (visibility === 'hide' || visibility === 'hidden') continue;
    const rank = typeof item.priority === 'number' ? item.priority : 10_000;
    sortable.push([rank, slug]);
  }

  sortable.sort((a, b) => (a[0] - b[0]) || a[1].localeCompare(b[1]));
  const deduped: string[] = [];
  for (const [, slug] of sortable) {
    if (!deduped.includes(slug)) deduped.push(slug);
  }
  return deduped;
}

/** Live fetch from the Codex backend. Returns [] on any failure (offline-safe). */
async function fetchModelsFromApi(accessToken: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CODEX_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: unknown };
    const models = data && typeof data === 'object' ? data.models : undefined;
    return addForwardCompatModels(parseModelEntries(models));
  } catch {
    // Network error, abort/timeout, or malformed JSON — fall back to local sources.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function codexHome(): string {
  const fromEnv = (process.env.CODEX_HOME ?? '').trim();
  return fromEnv || join(homedir(), '.codex');
}

/**
 * Read the top-level default `model` from ~/.codex/config.toml. Minimal TOML
 * scan (no dependency): matches `model = "..."` before the first `[section]`
 * header, mirroring tomllib's top-level `payload["model"]`.
 */
function readDefaultModel(home: string): string | null {
  const configPath = join(home, 'config.toml');
  if (!existsSync(configPath)) return null;
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break; // entered a section — stop scanning top-level keys
    const match = line.match(/^model\s*=\s*["']([^"']+)["']/);
    if (match) {
      const value = match[1].trim();
      return value || null;
    }
  }
  return null;
}

/** Read the Codex CLI's own model cache (~/.codex/models_cache.json). */
function readCacheModels(home: string): string[] {
  const cachePath = join(home, 'models_cache.json');
  if (!existsSync(cachePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as { models?: unknown };
    const models = raw && typeof raw === 'object' ? raw.models : undefined;
    return parseModelEntries(models);
  } catch {
    return [];
  }
}

/**
 * Return available Codex model IDs. Tries the live OAuth backend first (when a
 * token is supplied), then local Codex sources, then the curated fallback.
 * Forward-compat synthetic slugs are applied to whichever source wins.
 */
export async function getCodexModelIds(accessToken?: string): Promise<string[]> {
  if (accessToken) {
    const apiModels = await fetchModelsFromApi(accessToken);
    if (apiModels.length > 0) return apiModels;
  }

  const home = codexHome();
  const ordered: string[] = [];

  const defaultModel = readDefaultModel(home);
  if (defaultModel) ordered.push(defaultModel);

  for (const id of readCacheModels(home)) {
    if (!ordered.includes(id)) ordered.push(id);
  }

  for (const id of DEFAULT_CODEX_MODELS) {
    if (!ordered.includes(id)) ordered.push(id);
  }

  return addForwardCompatModels(ordered);
}
