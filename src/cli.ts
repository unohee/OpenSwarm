#!/usr/bin/env node
// ============================================
// OpenSwarm - CLI Entry Point
// `openswarm run`, `openswarm init`, `openswarm validate`, `openswarm chat`, `openswarm start`

import { Command, InvalidArgumentError } from 'commander';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './runners/cliRunner.js';
import { loadConfig, validateConfig, generateSampleConfig } from './core/config.js';
import { loadEnvFile } from './core/envFile.js';
import { initTelemetry, track } from './telemetry/telemetry.js';
import { maybeAutoUpdate } from './support/updateNotifier.js';

// Load .env so CLI commands (e.g. `auth login --provider linear` reading
// LINEAR_OAUTH_CLIENT_ID) see the same env the daemon does. Idempotent; never
// overrides an already-set shell var.
loadEnvFile();

// Read version from package.json so it stays in sync with the published package.
// cli.js lives at <pkg>/dist/cli.js, so package.json is one directory up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
const VERSION = pkg.version;

const program = new Command();

function parsePositiveIntegerOption(value: string): number {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError('must be a safe positive integer');
  }
  return parsed;
}

function loadTelemetryEnabledQuietly(quiet: boolean): boolean | undefined {
  if (!quiet) return loadConfig().telemetry?.enabled;
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    return loadConfig().telemetry?.enabled;
  } finally {
    console.log = originalLog;
  }
}

// Anonymous, opt-out usage telemetry (INT-1992). Honors OPENSWARM_TELEMETRY=0 /
// DO_NOT_TRACK / CI. One event per command invocation (command name only — never
// arguments). Fire-and-forget: not awaited, and track() never throws.
initTelemetry({ version: VERSION });
program.hook('preAction', (_thisCommand, actionCommand) => {
  // Honor config telemetry.enabled when a config exists (best-effort — `run`/`init`
  // may have none, in which case the env opt-out still applies).
  try {
    const opts = actionCommand.opts() as { json?: boolean };
    const quietConfigLoad = !!opts.json || actionCommand.name() === 'memory';
    initTelemetry({ version: VERSION, enabled: loadTelemetryEnabledQuietly(quietConfigLoad) });
  } catch {
    /* no/invalid config — leave the opt-out default */
  }
  void track({ command: actionCommand.name() });
});

program
  .name('openswarm')
  .description('Autonomous Claude Code agents orchestrator')
  .version(VERSION);

// openswarm run <task>

program
  .command('run')
  .description('Run a task through the agent pipeline (no config.yaml needed)')
  .argument('<task>', 'Task description to execute')
  .option('-p, --path <path>', 'Project path (default: current directory)')
  .option('-m, --model <model>', 'Model override for worker agent')
  .option('--pipeline', 'Full pipeline: worker + reviewer + tester + documenter')
  .option('--worker-only', 'Worker only, no review')
  .option('--max-iterations <n>', 'Max retry iterations', parsePositiveIntegerOption)
  .option('-v, --verbose', 'Enable detailed execution logging')
  .option('--no-learn', 'Do not record this run into the repo knowledge memory')
  .action(async (task: string, opts: {
    path?: string;
    model?: string;
    pipeline?: boolean;
    workerOnly?: boolean;
    maxIterations?: number;
    verbose?: boolean;
    learn?: boolean;
  }) => {
    await runCli({
      task,
      projectPath: opts.path,
      model: opts.model,
      pipeline: opts.pipeline,
      workerOnly: opts.workerOnly,
      maxIterations: opts.maxIterations,
      verbose: opts.verbose,
      learn: opts.learn,
    });
  });

// openswarm init

program
  .command('init')
  .description('Set up OpenSwarm (interactive wizard; --yes writes a sample config only)')
  .option('--force', 'Overwrite existing config file')
  .option('--yes, --non-interactive', 'Skip the wizard: write a sample config.yaml only (CI)')
  .action(async (opts: { force?: boolean; yes?: boolean; nonInteractive?: boolean }) => {
    // Non-interactive: keep the original config-only behavior for CI / scripting.
    if (opts.yes || opts.nonInteractive) {
      const configPath = join(process.cwd(), 'config.yaml');
      if (existsSync(configPath) && !opts.force) {
        console.error(`config.yaml already exists. Use --force to overwrite.`);
        process.exit(1);
      }
      writeFileSync(configPath, generateSampleConfig(), 'utf-8');
      console.log(`Created ${configPath}`);
      console.log('');
      console.log('Next steps:');
      console.log('  1. Set environment variables (DISCORD_TOKEN, LINEAR_API_KEY, etc.)');
      console.log('  2. Edit config.yaml with your project paths');
      console.log('  3. Run: openswarm validate');
      console.log('  4. Run: openswarm start');
      return;
    }

    const { runInitWizard } = await import('./cli/initWizard.js');
    await runInitWizard({ force: opts.force });
  });

// openswarm doctor

program
  .command('doctor')
  .description('Diagnose the environment (runtime, native deps, providers, ports, config)')
  .action(async () => {
    const { handleDoctor } = await import('./cli/doctorHandler.js');
    await handleDoctor();
  });

// openswarm validate

program
  .command('validate')
  .description('Validate the config.yaml file')
  .action(() => {
    try {
      const config = loadConfig();
      const validation = validateConfig(config);

      if (validation.valid) {
        console.log('Config is valid.');
        console.log(`  Agents: ${config.agents.map(a => a.name).join(', ')}`);
        if (config.autonomous?.enabled) {
          console.log(`  Autonomous mode: enabled`);
        }
        if (config.prProcessor?.enabled) {
          console.log(`  PR Processor: enabled`);
        }
      } else {
        console.error('Config validation errors:');
        for (const error of validation.errors) {
          console.error(`  - ${error}`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// openswarm chat

program
  .command('chat')
  .description('Start the interactive chat TUI with the configured provider')
  .argument('[session]', 'Session name to load/create (optional)')
  .option('--tui', 'Deprecated — chat always uses the TUI now (kept for compatibility)')
  .action(async (session?: string) => {
    // Always launch the TUI — the legacy readline path is retired.
    await launchChatTui(session);
  });

// openswarm resume — reopen the most recent chat session

program
  .command('resume')
  .description('Resume the most recently used chat session (its conversation + goal)')
  .action(async () => {
    const { latestSession } = await import('./support/chatSession.js');
    const id = await latestSession();
    if (!id) {
      console.log('No saved chat sessions to resume. Run `openswarm chat` to start one.');
      return;
    }
    console.log(`Resuming session ${id}…`);
    await launchChatTui(id);
  });

// openswarm mcp add|list|remove

program
  .command('mcp')
  .description('Manage MCP servers (~/.openswarm/mcp.json) available to the worker/CLI')
  .argument('<action>', 'add | list | remove')
  .argument('[name]', 'server name (for add/remove)')
  .argument('[target...]', 'command + args, or a URL (for add)')
  .option('--preset <preset>', 'use a built-in preset (e.g. linear) instead of a command/URL')
  .action(async (action: string, name: string | undefined, target: string[], opts: { preset?: string }) => {
    const { runMcpCommand } = await import('./cli/mcpCommand.js');
    try {
      console.log(runMcpCommand(action, name, target ?? [], { preset: opts.preset }));
      if (action === 'add' || action === 'remove') {
        const { resetMcpTools } = await import('./mcp/mcpClient.js');
        resetMcpTools();
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm memory status|compact

program
  .command('memory')
  .description('Inspect and maintain the repo knowledge memory DB')
  .argument('<action>', 'status | compact')
  .option('--json', 'Print JSON')
  .option('--force', 'Allow compact while the daemon is running')
  .action(async (action: string, opts: { json?: boolean; force?: boolean }) => {
    const { runMemoryCommand } = await import('./cli/memoryCommand.js');
    try {
      console.log(await runMemoryCommand(action, opts));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm schedule add|list|remove|pause

program
  .command('schedule')
  .description('Schedule agent tasks on a cron/interval (run by the daemon)')
  .argument('<action>', 'add | list | remove | pause')
  .argument('[args...]', 'add: <name> <cron|interval> <task...>; remove/pause: <name>')
  .option('--path <path>', 'Project path for the task (default: cwd)')
  .action(async (action: string, args: string[], opts: { path?: string }) => {
    const { runScheduleCommand } = await import('./cli/scheduleCommand.js');
    try {
      console.log(await runScheduleCommand(action, args ?? [], { path: opts.path }));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm design-pipeline

program
  .command('design-pipeline')
  .description('Analyze the project and generate a CI workflow (.github/workflows/ci.yml)')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--dry-run', 'Print the generated workflow without writing')
  .option('--force', 'Overwrite an existing ci.yml')
  .action(async (opts: { path?: string; dryRun?: boolean; force?: boolean }) => {
    const { runDesignPipeline } = await import('./cli/designPipeline.js');
    try {
      const r = runDesignPipeline({ path: opts.path, dryRun: opts.dryRun, force: opts.force });
      if (r.wrote) console.log(`Wrote ${r.path}`);
      else console.log(r.yaml);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm review

program
  .command('review')
  .description('Review the working-tree changes; --max audits the whole codebase with reviewer subagents')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--issues [parent]', 'File follow-ups as Linear sub-issues (parent inferred from the git branch, or pass an id)')
  .option('--issues-per-area [parent]', 'For --max: legacy per-area follow-up fan-out (skips the PM synthesis)')
  .option('--file [parent]', 'Alias for --issues (back-compat)')
  .option('--adapter <name>', 'Adapter override for the reviewer')
  .option('--debug', 'Verbose logging')
  // --max: full-codebase multi-agent audit (INT-2006)
  .option('--max', 'Audit the whole codebase: fan reviewer subagents out over directory-shaped areas')
  .option('--concurrency <n>', 'Max reviewer subagents in flight for --max (default 4)', parsePositiveIntegerOption)
  .option('--max-files-per-area <n>', 'Files per area before chunking, for --max (default 12)', parsePositiveIntegerOption)
  .option('--yes', 'Skip the --max cost-confirmation prompt')
  .option('--dry-run', 'For --max: print the area partition plan and exit (no subagents)')
  .option('--out <file>', 'For --max: write the markdown report here (default .openswarm/audit/audit-<ts>.md)')
  .option('--no-linear', 'For --max: skip creating the default Linear master audit issue')
  .option('--fallback <adapter>', 'For --max: retry usage-limited areas on this adapter (default: claude for codex)')
  .option('--no-fallback', 'For --max: disable the automatic usage-limit fallback')
  .option('--fix', 'For --max: apply the reviewer fixes to each flagged area, then re-review — looping up to --fix-rounds (working tree only, no commit)')
  .option('--fix-rounds <n>', 'For --max --fix: max fix → re-review rounds before giving up (default 3)', parsePositiveIntegerOption)
  .option('--no-learn', 'For --max: do not record the audit findings into the repo knowledge memory')
  .action(async (opts: {
    path?: string; issues?: string | boolean; issuesPerArea?: string | boolean; file?: string | boolean; adapter?: string; debug?: boolean;
    max?: boolean; concurrency?: number; maxFilesPerArea?: number; yes?: boolean; dryRun?: boolean;
    out?: string; linear?: boolean; fallback?: string | boolean; fix?: boolean; fixRounds?: number; learn?: boolean;
  }) => {
    try {
      if (opts.max) {
        const { runReviewMaxCommand } = await import('./cli/reviewMaxCommand.js');
        const result = await runReviewMaxCommand({
          path: opts.path,
          concurrency: opts.concurrency,
          maxFilesPerArea: opts.maxFilesPerArea,
          adapter: opts.adapter,
          fileIssue: opts.issues ?? opts.file,
          issuesPerArea: opts.issuesPerArea,
          yes: opts.yes,
          dryRun: opts.dryRun,
          out: opts.out,
          // commander sets opts.linear=false for --no-linear
          noLinear: opts.linear === false,
          // --fallback <adapter> → string; --no-fallback → false; default → undefined (auto)
          fallbackAdapter: typeof opts.fallback === 'string' ? opts.fallback : undefined,
          noFallback: opts.fallback === false,
          fix: opts.fix,
          fixRounds: opts.fixRounds,
          learn: opts.learn,
        });
        if (result && result.decision === 'reject') process.exitCode = 1;
        return;
      }
      const { runReviewCommand } = await import('./cli/reviewCommand.js');
      const result = await runReviewCommand({ path: opts.path, fileIssue: opts.issues ?? opts.file, adapter: opts.adapter, debug: opts.debug });
      if (result && result.decision === 'reject') process.exitCode = 1;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm fix — CI/test gate fan-out auto-fix (INT-2267)

program
  .command('fix')
  .description('Run the CI/test checks and fan a fix-worker out over the failures, re-running until green')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--checks <list>', 'Comma list of checks (lint,type,build,test or script/config names); default: auto-detected from openswarm.json "checks", package.json scripts, Cargo.toml, or Python config', (v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--concurrency <n>', 'Max fix workers in flight (default 4)', (v) => parseInt(v, 10))
  .option('--rounds <n>', 'Max check → fix → re-check rounds (default 3)', (v) => parseInt(v, 10))
  .option('--adapter <name>', 'Adapter override for the fix workers')
  .option('--timeout <ms>', 'Per-area fix worker timeout in ms (default 900000 = 15 min)', parsePositiveIntegerOption)
  .option('--no-learn', 'Do not record a successful fix into the repo knowledge memory')
  .action(async (opts: { path?: string; checks?: string[]; concurrency?: number; rounds?: number; adapter?: string; timeout?: number; learn?: boolean }) => {
    try {
      const { runFixCommand } = await import('./cli/fixCommand.js');
      const report = await runFixCommand({
        path: opts.path,
        checks: opts.checks,
        concurrency: opts.concurrency,
        rounds: opts.rounds,
        adapter: opts.adapter as import('./adapters/types.js').AdapterName | undefined,
        timeoutMs: opts.timeout,
        learn: opts.learn,
      });
      if (!report.green) process.exitCode = 1;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

// openswarm exec <prompt>

program
  .command('exec')
  .description('Execute a task via the running daemon (auto-starts if needed)')
  .argument('<prompt>', 'Task prompt to execute')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--timeout <seconds>', 'Timeout in seconds (default: 600)', parseInt)
  .option('--no-auto-start', 'Do not auto-start the service')
  .option('--local', 'Execute locally without daemon')
  .option('--pipeline', 'Full pipeline: worker + reviewer + tester + documenter')
  .option('--worker-only', 'Worker only, no review')
  .option('-m, --model <model>', 'Model override for worker')
  .option('-v, --verbose', 'Enable detailed execution logging')
  .action(async (prompt: string, opts: {
    path?: string;
    timeout?: number;
    autoStart?: boolean;
    local?: boolean;
    pipeline?: boolean;
    workerOnly?: boolean;
    model?: string;
    verbose?: boolean;
  }) => {
    const { executePrompt } = await import('./cli/promptHandler.js');
    await executePrompt({ prompt, ...opts });
  });

// openswarm start

program
  .command('start')
  .description('Start the full daemon in the background (use --foreground to stay attached)')
  .option('-F, --foreground', 'Run in the foreground instead of detaching (for debugging / LaunchAgent)')
  .action(async (opts: { foreground?: boolean }) => {
    if (opts.foreground) {
      // Dynamic import triggers the top-level main() in index.ts
      await import('./index.js');
      return;
    }

    const { startDaemon, getDaemonStatus, readLogTail } = await import('./cli/daemon.js');
    try {
      const { pid, logFile } = startDaemon();
      // The child can die immediately on a startup error (bad config, port in
      // use, throwing dependency). Spawning only proves the OS forked it — wait
      // briefly and confirm it's actually alive before claiming success, so we
      // never print "started" for a daemon that `status` will call "not running".
      await new Promise((r) => setTimeout(r, 1500));
      if (!getDaemonStatus().running) {
        console.error('OpenSwarm exited during startup. Recent log:');
        console.error('────────────────────────────────────────');
        console.error(readLogTail(25));
        console.error('────────────────────────────────────────');
        console.error(`Full log: ${logFile}`);
        process.exit(1);
      }
      console.log(`OpenSwarm started in background (pid ${pid}).`);
      console.log(`  logs:    ${logFile}`);
      console.log(`  stop:    openswarm stop`);
      console.log(`  status:  openswarm status`);
    } catch (err) {
      console.error(`Failed to start: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// openswarm stop

program
  .command('stop')
  .description('Stop the background daemon (sends SIGTERM)')
  .option('-t, --timeout <ms>', 'Max time to wait for graceful shutdown (default 10000)', '10000')
  .action(async (opts: { timeout: string }) => {
    const timeoutMs = parseInt(opts.timeout, 10);
    const { stopDaemon } = await import('./cli/daemon.js');
    try {
      const stopped = await stopDaemon(Number.isFinite(timeoutMs) ? timeoutMs : 10_000);
      if (!stopped) {
        console.log('OpenSwarm is not running.');
        return;
      }
      console.log('OpenSwarm stopped.');
    } catch (err) {
      console.error(`Failed to stop: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// openswarm status

program
  .command('status')
  .description('Report daemon status (pid, uptime, log path)')
  .action(async () => {
    const { getDaemonStatus } = await import('./cli/daemon.js');
    const status = getDaemonStatus();
    if (!status.running) {
      console.log('OpenSwarm is not running.');
      console.log(`  pid file: ${status.pidFile}`);
      console.log(`  log file: ${status.logFile}`);
      return;
    }
    const uptime = status.uptimeSeconds ?? 0;
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    console.log(`OpenSwarm is running.`);
    console.log(`  pid:    ${status.pid}`);
    console.log(`  uptime: ${h}h ${m}m ${s}s`);
    console.log(`  logs:   ${status.logFile}`);
  });

// openswarm dash

program
  .command('dash')
  .description('Open the web dashboard in a browser')
  .option('-p, --port <port>', 'Port number', '3847')
  .option('--no-open', 'Start server without opening browser')
  .action(async (opts: { port: string; open: boolean }) => {
    const port = parseInt(opts.port, 10);
    const { startWebServer } = await import('./support/web.js');
    await startWebServer(port);
    console.log(`Dashboard running at http://localhost:${port}`);

    if (opts.open) {
      const { exec } = await import('node:child_process');
      const url = `http://localhost:${port}`;
      const cmd = process.platform === 'darwin' ? `open "${url}"`
        : process.platform === 'win32' ? `start "${url}"`
        : `xdg-open "${url}"`;
      exec(cmd, (err) => {
        if (err) console.log(`Open ${url} in your browser`);
      });
    }

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nDashboard stopped.');
      process.exit(0);
    });
  });

// openswarm check

program
  .command('check')
  .description('Check code registry for a file or show registry stats')
  .argument('[filePath]', 'File path to inspect (relative to project root)')
  .option('--stats', 'Show overall registry statistics')
  .option('--deprecated', 'List all deprecated entities')
  .option('--untested', 'List all untested entities')
  .option('--high-risk', 'List all high-risk entities')
  .option('--tag <tag>', 'List entities with a specific tag')
  .option('--search <query>', 'Full-text search entities')
  .option('--scan', 'Scan entire repository and sync to registry')
  .option('--bs', 'Scan for BS patterns (bad code smells)')
  .option('--tree', 'Display codebase tree with entity counts and risk')
  .option('--ci', 'CI/CD mode: JSON output, exit 1 on critical issues')
  .option('-v, --verbose', 'Verbose output (with --scan)')
  .option('--project <id>', 'Filter by project ID')
  .action(async (filePath: string | undefined, opts: {
    stats?: boolean;
    deprecated?: boolean;
    untested?: boolean;
    highRisk?: boolean;
    tag?: string;
    search?: string;
    scan?: boolean;
    bs?: boolean;
    tree?: boolean;
    ci?: boolean;
    verbose?: boolean;
    project?: string;
  }) => {
    const { handleCheck } = await import('./cli/checkHandler.js');
    await handleCheck(filePath, opts);
  });

// openswarm check annotate <qualifiedName>

program
  .command('annotate')
  .description('Annotate a code entity in the registry')
  .argument('<qualifiedName>', 'Entity qualified name (file::name) or search term')
  .option('--deprecate [reason]', 'Mark as deprecated')
  .option('--status <status>', 'Set status (active|experimental|planned|broken)')
  .option('--tag <tag>', 'Add a tag (key or key=value)')
  .option('--untag <tag>', 'Remove a tag')
  .option('--note <text>', 'Add a note')
  .option('--risk <level>', 'Set risk level (low|medium|high)')
  .option('--warn <message>', 'Add a warning (format: severity/category: message)')
  .action(async (qualifiedName: string, opts: {
    deprecate?: string | boolean;
    status?: string;
    tag?: string;
    untag?: string;
    note?: string;
    risk?: string;
    warn?: string;
  }) => {
    const { handleAnnotate } = await import('./cli/checkHandler.js');
    await handleAnnotate(qualifiedName, opts);
  });

// openswarm auth

const authCmd = program
  .command('auth')
  .description('Manage OAuth authentication for providers');

authCmd
  .command('login')
  .description('Login via OAuth/PKCE (gpt, openrouter, linear)')
  .option('--provider <provider>', 'Provider to authenticate (gpt | openrouter | linear)', 'gpt')
  .option('--client-id <clientId>', 'GPT only: override OAuth Client ID (defaults to the public Codex client)')
  .option('--api-key <apiKey>', 'OpenRouter only: skip browser flow and store this sk-or-* key directly')
  .option('--port <port>', 'Callback server port', parseInt)
  .action(async (opts: { provider: string; clientId?: string; apiKey?: string; port?: number }) => {
    const { handleAuthLogin } = await import('./cli/authHandler.js');
    await handleAuthLogin(opts.provider, opts);
  });

authCmd
  .command('status')
  .description('Show stored auth profiles')
  .action(async () => {
    const { handleAuthStatus } = await import('./cli/authHandler.js');
    handleAuthStatus();
  });

authCmd
  .command('models')
  .description('List available Codex models (live via OAuth, offline fallback otherwise)')
  .action(async () => {
    const { handleAuthModels } = await import('./cli/authHandler.js');
    await handleAuthModels();
  });

authCmd
  .command('logout')
  .description('Remove stored auth tokens')
  .option('--provider <provider>', 'Provider to remove (gpt | openrouter | linear)', 'gpt')
  .action(async (opts: { provider: string }) => {
    const { handleAuthLogout } = await import('./cli/authHandler.js');
    handleAuthLogout(opts.provider);
  });

// Work-repo management — register which repos the daemon operates on

program
  .command('add')
  .description('Register a repository as a work repo (enabled + pinned)')
  .argument('<path>', 'Path to the git repository')
  .action(async (path: string) => {
    const { handleProjectAdd } = await import('./cli/projectHandler.js');
    await handleProjectAdd(path);
  });

program
  .command('projects')
  .description('List registered work repositories')
  .action(async () => {
    const { handleProjectList } = await import('./cli/projectHandler.js');
    handleProjectList();
  });

program
  .command('remove')
  .description('Unregister a work repository (adds it to the denylist)')
  .argument('<path>', 'Path to the repository')
  .action(async (path: string) => {
    const { handleProjectRm } = await import('./cli/projectHandler.js');
    handleProjectRm(path);
  });

// 서브커맨드 없이 `openswarm`만 입력 시 → TUI chat 실행 (`openswarm chat`과 동일)

async function launchChatTui(sessionId?: string): Promise<void> {
  // Auto-start the background daemon so the monitor tabs (Projects/Tasks/Stuck/
  // Issues) — which are read-only clients of the daemon's :3847 API — have data
  // to show. If it's already running or fails to start, just continue: the chat
  // agent itself doesn't depend on the daemon. Done before console muting so the
  // one-line status is visible.
  try {
    const { getDaemonStatus, startDaemon } = await import('./cli/daemon.js');
    if (!getDaemonStatus().running) {
      const { pid } = startDaemon();
      process.stdout.write(`Starting OpenSwarm daemon (pid ${pid}) for the monitor tabs…\n`);
      await new Promise((r) => setTimeout(r, 1500));
      if (!getDaemonStatus().running) {
        process.stdout.write('Daemon did not stay up; monitor tabs may be empty. Run `openswarm status` to see why.\n');
      }
    }
  } catch {
    // Non-fatal — chat works without the daemon.
  }

  // Ink cockpit (EPIC INT-1813): React reconciler diffs the screen, so there's
  // no blessed terminfo noise to mute and no manual redraw/flicker. The old
  // console-mute hack is gone with blessed.
  const { startInkTui } = await import('./tui/index.js');
  const { loadDefaultProvider, loadSession, generateSessionId } = await import('./support/chatSession.js');
  const { getDefaultChatModel } = await import('./support/chatBackend.js');

  // Resume an existing session when an id is given, else start a fresh one. A
  // missing id falls back to a new session rather than erroring. (INT-2014)
  let provider = loadDefaultProvider();
  let model = getDefaultChatModel(provider);
  let initialHistory: import('./tui/chatModel.js').ChatLine[] | undefined;
  let goal: string | undefined;
  let resolvedSessionId = sessionId ?? generateSessionId();
  if (sessionId) {
    const sess = await loadSession(sessionId);
    if (sess) {
      provider = sess.provider;
      model = sess.model;
      goal = sess.goal;
      const { messagesToHistory } = await import('./tui/chatModel.js');
      initialHistory = messagesToHistory(sess.messages);
      resolvedSessionId = sess.id;
    } else {
      process.stdout.write(`Session "${sessionId}" not found — starting a new session.\n`);
    }
  }
  const cwd = process.cwd();
  let branch: string | undefined;
  try {
    const { execFileSync } = await import('node:child_process');
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || undefined;
  } catch {
    // not a git repo — omit the branch
  }
  await startInkTui({ version: VERSION, provider, model, port: 3847, cwd, branch, sessionId: resolvedSessionId, initialHistory, goal });
}

program.action(launchChatTui);

// Parse & Execute

// Auto-update from npm before dispatching: if a newer version is published,
// `npm i -g` it and re-exec on the new binary (default ON; opt out with
// OPENSWARM_NO_AUTO_UPDATE → passive notice). Cached 24h, skips CI/non-TTY/meta,
// never blocks the CLI. (INT-2394, extends INT-2270)
await maybeAutoUpdate(VERSION);
program.parse();
