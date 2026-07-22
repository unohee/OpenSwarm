// ============================================
// OpenSwarm - OAuth Token Store
// Persistent storage + auto-refresh for OAuth tokens
// ============================================

import { readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFileSync } from '../support/atomicFile.js';

// Types

export interface AuthProfile {
  /**
   * oauth: short-lived access_token + refresh_token (e.g. ChatGPT Codex)
   * apiKey: long-lived bearer token, no refresh flow (e.g. OpenRouter sk-or-*)
   */
  type: 'oauth' | 'apiKey';
  provider: string;
  access: string;
  /** Empty string when `type === 'apiKey'` (no refresh available). */
  refresh: string;
  /**
   * ms timestamp at which `access` expires.
   * For `type === 'apiKey'` this is set to Number.MAX_SAFE_INTEGER (never expires).
   */
  expires: number;
  /** OAuth client_id for the issuer. Empty string for plain API keys. */
  clientId: string;
  accountId?: string;
}

interface AuthProfileFile {
  version: 1;
  profiles: Record<string, AuthProfile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthProfile(value: unknown): value is AuthProfile {
  if (!isRecord(value)) return false;
  if (value.type !== 'oauth' && value.type !== 'apiKey') return false;
  return (
    typeof value.provider === 'string' &&
    typeof value.access === 'string' &&
    typeof value.refresh === 'string' &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires) &&
    typeof value.clientId === 'string' &&
    (value.accountId === undefined || typeof value.accountId === 'string')
  );
}

function isAuthProfileFile(value: unknown): value is AuthProfileFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.profiles)) {
    return false;
  }
  return Object.values(value.profiles).every(isAuthProfile);
}

// Constants

const STORE_PATH = join(homedir(), '.openswarm', 'auth-profiles.json');
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5분 전에 갱신
const OPENAI_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const LINEAR_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';

/** OAuth refresh token endpoints by provider. */
const TOKEN_ENDPOINTS: Record<string, string> = {
  'openai-gpt': OPENAI_TOKEN_ENDPOINT,
  linear: LINEAR_TOKEN_ENDPOINT,
};

// AuthProfileStore

export class AuthProfileStore {
  private data: AuthProfileFile;

  constructor() {
    this.data = this.load();
  }

  private load(): AuthProfileFile {
    if (!existsSync(STORE_PATH)) {
      return { version: 1, profiles: {} };
    }
    try {
      const raw = readFileSync(STORE_PATH, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isAuthProfileFile(parsed)) throw new Error('auth profile schema validation failed');
      return parsed;
    } catch (error) {
      const corruptPath = `${STORE_PATH}.corrupt-${Date.now()}`;
      try { renameSync(STORE_PATH, corruptPath); } catch { /* preserve original read error */ }
      throw new Error(`Auth profile store is corrupt; preserved at ${corruptPath}`, { cause: error });
    }
  }

  save(): void {
    atomicWriteFileSync(STORE_PATH, `${JSON.stringify(this.data, null, 2)}\n`, 0o600);
  }

  getProfile(key: string): AuthProfile | null {
    return this.data.profiles[key] ?? null;
  }

  setProfile(key: string, profile: AuthProfile): void {
    this.data.profiles[key] = profile;
    this.save();
  }

  deleteProfile(key: string): boolean {
    if (!(key in this.data.profiles)) return false;
    delete this.data.profiles[key];
    this.save();
    return true;
  }

  listProfiles(): Record<string, AuthProfile> {
    return { ...this.data.profiles };
  }
}

// Token refresh

/**
 * 유효한 access token 반환. 만료 임박 시 자동 refresh.
 */
export async function ensureValidToken(store: AuthProfileStore, profileKey: string): Promise<string> {
  const profile = store.getProfile(profileKey);
  if (!profile) {
    throw new Error(`Auth profile "${profileKey}" not found. Run: openswarm auth login --provider gpt`);
  }

  // API keys never expire and have no refresh flow.
  if (profile.type === 'apiKey') {
    return profile.access;
  }

  const now = Date.now();
  if (now < profile.expires - REFRESH_BUFFER_MS) {
    return profile.access;
  }

  // Token 갱신
  console.log(`[Auth] Refreshing token for ${profileKey}...`);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: profile.refresh,
    client_id: profile.clientId,
  });

  const endpoint = TOKEN_ENDPOINTS[profile.provider];
  if (!endpoint) {
    throw new Error(`Unknown OAuth provider "${profile.provider}" for auth profile "${profileKey}". Re-run auth login for this provider.`);
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const reauth = profile.provider === 'linear' ? 'linear' : 'gpt';
    throw new Error(
      `Token refresh failed (${res.status}): ${errText.slice(0, 200)}. Run: openswarm auth login --provider ${reauth}`,
    );
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  profile.access = tokens.access_token;
  if (tokens.refresh_token) {
    profile.refresh = tokens.refresh_token;
  }
  profile.expires = Date.now() + tokens.expires_in * 1000;

  store.setProfile(profileKey, profile);
  console.log(`[Auth] Token refreshed successfully.`);

  return profile.access;
}
