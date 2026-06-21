// ============================================
// OpenSwarm - Claude Code Quota Tracker
// Fetches subscription quota via OAuth API
// ============================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface QuotaWindow {
  utilization: number; // 0-100
  resets_at: string;   // ISO 8601
}

export interface QuotaExtraUsage {
  is_enabled: boolean;
  monthly_limit: number;
  used_credits: number;
  utilization: number | null;
}

export interface QuotaInfo {
  five_hour: QuotaWindow | null;
  seven_day: QuotaWindow | null;
  seven_day_opus: QuotaWindow | null;
  seven_day_sonnet: QuotaWindow | null;
  extra_usage: QuotaExtraUsage | null;
  fetched_at: number; // epoch ms
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

let cached: QuotaInfo | null = null;

function readAccessToken(): string | null {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function fetchQuota(): Promise<QuotaInfo | null> {
  // Anthropic usage polling removed: the worker runs on codex/openrouter, not Claude Max, so
  // hitting api.anthropic.com/oauth/usage only produced 401/429 noise (the gate that used it was
  // already removed). The quota widget is disabled — /api/quota returns null.
  void cached; void CACHE_TTL_MS; void readAccessToken; // kept to avoid churn; intentionally unused
  return null;
}

/**
 * Check if quota utilization is below the safety threshold.
 * Returns { allowed: true } or { allowed: false, reason: string }
 */
export async function checkQuotaAllowance(thresholdPercent: number = 80): Promise<{
  allowed: boolean;
  reason?: string;
  utilization?: number;
}> {
  const quota = await fetchQuota();
  if (!quota) {
    // Can't check quota — allow by default (fail-open)
    return { allowed: true, reason: 'Quota unavailable (fail-open)' };
  }

  // Check 5-hour window (most restrictive for burst usage)
  if (quota.five_hour && quota.five_hour.utilization >= thresholdPercent) {
    return {
      allowed: false,
      reason: `5h quota ${quota.five_hour.utilization.toFixed(0)}% >= ${thresholdPercent}% threshold (resets ${quota.five_hour.resets_at})`,
      utilization: quota.five_hour.utilization,
    };
  }

  // Check 7-day window
  if (quota.seven_day && quota.seven_day.utilization >= thresholdPercent) {
    return {
      allowed: false,
      reason: `7d quota ${quota.seven_day.utilization.toFixed(0)}% >= ${thresholdPercent}% threshold (resets ${quota.seven_day.resets_at})`,
      utilization: quota.seven_day.utilization,
    };
  }

  const currentUtil = quota.five_hour?.utilization ?? quota.seven_day?.utilization ?? 0;
  return { allowed: true, utilization: currentUtil };
}
