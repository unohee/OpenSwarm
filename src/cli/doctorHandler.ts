// ============================================
// OpenSwarm - `openswarm doctor`
// Fresh-install self-diagnosis: runtime, native modules, external CLIs,
// providers, ports, config, Linear. Exits non-zero on critical issues.
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { listAvailableAdapters } from '../adapters/index.js';
import { findConfigFile } from '../core/config.js';
import { banner } from '../support/banner.js';
import { c } from '../support/colors.js';

const execFileAsync = promisify(execFile);

type Status = 'ok' | 'warn' | 'fail';

function line(status: Status, label: string, detail = ''): void {
  const icon = status === 'ok' ? c.green('✓') : status === 'warn' ? c.yellow('⚠') : c.red('✗');
  console.log(`${icon} ${c.bold(label)}${detail ? ` ${c.dim('—')} ${c.dim(detail)}` : ''}`);
}

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** True if the TCP port is free to bind on localhost. */
async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export async function handleDoctor(): Promise<void> {
  console.log(banner('doctor — environment check'));
  let fatal = false;

  // 1) Node.js runtime
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= 22) {
    line('ok', 'Node.js', process.version);
  } else {
    line('fail', 'Node.js', `${process.version} — need >= 22`);
    fatal = true;
  }

  // 2) Native modules (prebuilt binaries on common platforms; else build toolchain)
  for (const mod of ['better-sqlite3', '@lancedb/lancedb']) {
    try {
      await import(mod);
      line('ok', `native: ${mod}`, 'loads');
    } catch {
      line('fail', `native: ${mod}`, 'load failed — install python3 + a C/C++ toolchain, then reinstall');
      fatal = true;
    }
  }

  // 3) External CLIs on PATH
  const clis: Array<[string, Status, string]> = [
    ['codex', 'warn', 'codex provider'],
    ['claude', 'warn', 'claude (opt-in) provider'],
    ['git', 'warn', 'required for worktree mode / PRs'],
    ['gh', 'warn', 'optional — CI monitoring'],
  ];
  for (const [bin, missStatus, note] of clis) {
    const path = await which(bin);
    if (path) line('ok', `cli: ${bin}`, path);
    else line(missStatus, `cli: ${bin}`, `not on PATH (${note})`);
  }

  // 4) LLM providers (env keys + OAuth profiles + PATH binaries + local servers)
  const available = await listAvailableAdapters();
  if (available.length > 0) {
    line('ok', 'providers', available.join(', '));
  } else {
    line('fail', 'providers', 'none usable — run `openswarm auth login` (codex/gpt/openrouter) or start a local model');
    fatal = true;
  }

  // 5) Ports (web dashboard + OAuth callbacks)
  const ports: Array<[number, string]> = [
    [3847, 'web dashboard'],
    [1455, 'codex OAuth callback'],
    [1456, 'openrouter OAuth callback'],
    [1457, 'linear OAuth callback'],
  ];
  for (const [port, use] of ports) {
    const free = await portFree(port);
    line(free ? 'ok' : 'warn', `port ${port}`, free ? `free (${use})` : `in use (${use}) — close the holder before that flow`);
  }

  // 6) Config file resolution (cwd ./config.yaml vs ~/.config/openswarm)
  const cfg = findConfigFile();
  if (cfg) line('ok', 'config', cfg);
  else line('warn', 'config', 'none found — run `openswarm init` (or set OPENSWARM_CONFIG)');

  // 7) Linear task source (optional)
  const { AuthProfileStore } = await import('../auth/index.js');
  const hasOAuth = !!new AuthProfileStore().getProfile('linear:default');
  const hasKey = !!process.env.LINEAR_API_KEY;
  if (hasOAuth || hasKey) line('ok', 'linear', hasOAuth ? 'OAuth profile' : 'API key');
  else line('warn', 'linear', 'not configured — local SQLite issue store will be used');

  console.log('');
  if (fatal) {
    console.log(c.red(c.bold('✗ Critical issues found — fix the ✗ items above.')));
    process.exit(1);
  }
  console.log(c.green(c.bold('✓ No critical issues.')));
}
