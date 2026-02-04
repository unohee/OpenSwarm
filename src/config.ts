// ============================================
// Claude Swarm - Configuration
// ============================================

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SwarmConfig, AgentSession } from './types.js';

const CONFIG_PATH = join(process.cwd(), 'config.json');
const DEFAULT_HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30분

/**
 * 환경 변수에서 설정 로드
 */
function loadFromEnv(): Partial<SwarmConfig> {
  return {
    discordToken: process.env.DISCORD_TOKEN,
    discordChannelId: process.env.DISCORD_CHANNEL_ID,
    linearApiKey: process.env.LINEAR_API_KEY,
    linearTeamId: process.env.LINEAR_TEAM_ID,
  };
}

/**
 * config.json에서 설정 로드
 */
function loadFromFile(): Partial<SwarmConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Failed to load config from ${CONFIG_PATH}:`, err);
    return {};
  }
}

/**
 * 설정 로드 (환경변수 > config.json > 기본값)
 */
export function loadConfig(): SwarmConfig {
  const fromFile = loadFromFile();
  const fromEnv = loadFromEnv();

  const config: SwarmConfig = {
    discordToken: fromEnv.discordToken ?? fromFile.discordToken ?? '',
    discordChannelId: fromEnv.discordChannelId ?? fromFile.discordChannelId ?? '',
    linearApiKey: fromEnv.linearApiKey ?? fromFile.linearApiKey ?? '',
    linearTeamId: fromEnv.linearTeamId ?? fromFile.linearTeamId ?? '',
    agents: fromFile.agents ?? [],
    defaultHeartbeatInterval: fromFile.defaultHeartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
  };

  return config;
}

/**
 * 설정 유효성 검사
 */
export function validateConfig(config: SwarmConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.discordToken) {
    errors.push('Discord token is required (DISCORD_TOKEN or config.discordToken)');
  }

  if (!config.discordChannelId) {
    errors.push('Discord channel ID is required (DISCORD_CHANNEL_ID or config.discordChannelId)');
  }

  if (!config.linearApiKey) {
    errors.push('Linear API key is required (LINEAR_API_KEY or config.linearApiKey)');
  }

  if (!config.linearTeamId) {
    errors.push('Linear team ID is required (LINEAR_TEAM_ID or config.linearTeamId)');
  }

  if (config.agents.length === 0) {
    errors.push('At least one agent session is required in config.agents');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 기본 에이전트 세션 생성
 */
export function createAgentSession(
  name: string,
  projectPath: string,
  options?: Partial<AgentSession>
): AgentSession {
  return {
    name,
    projectPath,
    heartbeatInterval: options?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
    linearLabel: options?.linearLabel ?? name,
    enabled: options?.enabled ?? true,
    paused: options?.paused ?? false,
  };
}
