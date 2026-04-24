#!/usr/bin/env node
// ============================================
// OpenSwarm - Entry Point
// ============================================

// Prevent IPv6 ETIMEDOUT: external APIs (Linear SDK etc.) try IPv6 first → causes timeout
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// Load .env before anything else — config.yaml uses ${LINEAR_API_KEY} etc.
// and would otherwise silently disable integrations when the daemon is
// launched from a non-interactive shell without those vars exported.
import { loadEnvFile } from './core/envFile.js';
const envLoad = loadEnvFile();
if (envLoad.path !== null) {
  console.log(`Loaded env from: ${envLoad.path} (${envLoad.loadedKeys.length} keys)`);
}

// Strip Claude Code session markers so child processes (worker, planner) can launch Claude CLI
// Without this, running the service from inside a Claude Code session blocks all CLI spawns.
delete process.env['CLAUDECODE'];
delete process.env['CLAUDE_CODE_ENTRYPOINT'];

import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from './core/config.js';
import { startService, stopService } from './core/service.js';
import { DAEMON_PATHS } from './cli/daemon.js';

// index.js lives at <pkg>/dist/index.js → package.json is one level up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
const VERSION = pkg.version;

async function main(): Promise<void> {
  // Render a fixed-width banner (41 chars inside the box) with the current version.
  const title = `🤖 OpenSwarm v${VERSION}`;
  const INNER_WIDTH = 40;
  // '🤖' counts as 2 display columns in most terminals, so pad assuming width = length + 1.
  const visualLen = title.length + 1;
  const padTotal = Math.max(0, INNER_WIDTH - visualLen);
  const padLeft = Math.floor(padTotal / 2);
  const padRight = padTotal - padLeft;
  console.log('╔════════════════════════════════════════╗');
  console.log(`║${' '.repeat(padLeft)}${title}${' '.repeat(padRight)}║`);
  console.log('║   Autonomous Claude Code Orchestrator  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // Load configuration
  const config = loadConfig();

  // Validate configuration
  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error('Configuration errors:');
    for (const error of validation.errors) {
      console.error(`  - ${error}`);
    }
    console.error('');
    console.error('Please check config.json or environment variables.');
    process.exit(1);
  }

  console.log('Configuration loaded:');
  console.log(`  - Agents: ${config.agents.map((a) => a.name).join(', ')}`);
  console.log(`  - Default heartbeat: ${config.defaultHeartbeatInterval / 60000}min`);
  console.log('');

  // Signal handlers
  const isDaemon = process.env.OPENSWARM_DAEMON === '1';
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await stopService();
    if (isDaemon) {
      try { unlinkSync(DAEMON_PATHS.PID_FILE); } catch { /* ignore */ }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start service
  try {
    await startService(config);
    console.log('');
    console.log('OpenSwarm is running. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Failed to start service:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
