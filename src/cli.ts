#!/usr/bin/env node
// ============================================
// OpenSwarm - CLI Entry Point
// `openswarm run`, `openswarm init`, `openswarm validate`, `openswarm chat`, `openswarm start`

import { Command } from 'commander';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './runners/cliRunner.js';
import { loadConfig, validateConfig, generateSampleConfig } from './core/config.js';

// Read version from package.json so it stays in sync with the published package.
// cli.js lives at <pkg>/dist/cli.js, so package.json is one directory up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
const VERSION = pkg.version;

const program = new Command();

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
  .option('--max-iterations <n>', 'Max retry iterations', parseInt)
  .option('-v, --verbose', 'Enable detailed execution logging')
  .action(async (task: string, opts: {
    path?: string;
    model?: string;
    pipeline?: boolean;
    workerOnly?: boolean;
    maxIterations?: number;
    verbose?: boolean;
  }) => {
    await runCli({
      task,
      projectPath: opts.path,
      model: opts.model,
      pipeline: opts.pipeline,
      workerOnly: opts.workerOnly,
      maxIterations: opts.maxIterations,
      verbose: opts.verbose,
    });
  });

// openswarm init

program
  .command('init')
  .description('Generate a sample config.yaml in the current directory')
  .option('--force', 'Overwrite existing config file')
  .action((opts: { force?: boolean }) => {
    const configPath = join(process.cwd(), 'config.yaml');

    if (existsSync(configPath) && !opts.force) {
      console.error(`config.yaml already exists. Use --force to overwrite.`);
      process.exit(1);
    }

    const content = generateSampleConfig();
    writeFileSync(configPath, content, 'utf-8');
    console.log(`Created ${configPath}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Set environment variables (DISCORD_TOKEN, LINEAR_API_KEY, etc.)');
    console.log('  2. Edit config.yaml with your project paths');
    console.log('  3. Run: openswarm validate');
    console.log('  4. Run: openswarm start');
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
  .description('Start interactive chat CLI with the configured provider')
  .argument('[session]', 'Session name to load/create (optional)')
  .option('--tui', 'Enable rich TUI mode (default: simple readline)')
  .action(async (session?: string, opts?: { tui?: boolean }) => {
    // Pass session argument via process.argv for chat.ts to pick up
    if (session) {
      process.argv = [process.argv[0], process.argv[1], session];
    }

    // Use TUI mode if requested
    if (opts?.tui) {
      const { main } = await import('./support/chatTui.js');
      await main();
    } else {
      // Legacy readline mode
      await import('./support/chat.js');
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
  .description('Start the full daemon (requires config.yaml with Discord + Linear)')
  .action(async () => {
    // Dynamic import triggers the top-level main() in index.ts
    await import('./index.js');
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

const checkAnnotate = program
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
  .description('Login via OAuth (GPT)')
  .option('--provider <provider>', 'Provider to authenticate', 'gpt')
  .option('--client-id <clientId>', 'OAuth Client ID (or set OPENAI_CLIENT_ID env)')
  .option('--port <port>', 'Callback server port', parseInt)
  .action(async (opts: { provider: string; clientId?: string; port?: number }) => {
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
  .command('logout')
  .description('Remove stored auth tokens')
  .option('--provider <provider>', 'Provider to remove', 'gpt')
  .action(async (opts: { provider: string }) => {
    const { handleAuthLogout } = await import('./cli/authHandler.js');
    handleAuthLogout(opts.provider);
  });

// 서브커맨드 없이 `openswarm`만 입력 시 → TUI chat 실행

program.action(async () => {
  const { main } = await import('./support/chatTui.js');
  await main();
});

// Parse & Execute

program.parse();
