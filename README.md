# OpenSwarm

> Autonomous AI agent orchestrator powered by Claude Code CLI

OpenSwarm orchestrates multiple Claude Code instances as autonomous agents. It picks up Linear issues, runs Worker/Reviewer pair pipelines to produce code changes, reports progress to Discord, and retains long-term memory via LanceDB vector embeddings.

## Architecture

```
                         ┌──────────────────────────┐
                         │       Linear API          │
                         │   (issues, state, memory) │
                         └─────────────┬────────────┘
                                       │
                 ┌─────────────────────┼─────────────────────┐
                 │                     │                     │
                 v                     v                     v
  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │ AutonomousRunner │  │  DecisionEngine  │  │  TaskScheduler   │
  │ (heartbeat loop) │─>│  (scope guard)   │─>│  (queue + slots) │
  └────────┬─────────┘  └──────────────────┘  └────────┬─────────┘
           │                                            │
           v                                            v
  ┌──────────────────────────────────────────────────────────────┐
  │                      PairPipeline                            │
  │  ┌────────┐   ┌──────────┐   ┌────────┐   ┌─────────────┐  │
  │  │ Worker │──>│ Reviewer │──>│ Tester │──>│ Documenter  │  │
  │  │ (CLI)  │<──│  (CLI)   │   │ (CLI)  │   │   (CLI)     │  │
  │  └────────┘   └──────────┘   └────────┘   └─────────────┘  │
  │       ↕ StuckDetector                                        │
  └──────────────────────────────────────────────────────────────┘
           │                     │                     │
           v                     v                     v
  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │  Discord Bot │  │  Memory (LanceDB │  │  Knowledge Graph │
  │  (commands)  │  │  + Xenova E5)    │  │  (code analysis) │
  └──────────────┘  └──────────────────┘  └──────────────────┘
```

## Features

- **Autonomous Pipeline** - Cron-driven heartbeat fetches Linear issues, runs Worker/Reviewer pair loops, and updates issue state automatically
- **Worker/Reviewer Pairs** - Multi-iteration code generation with automated review, testing, and documentation stages
- **Decision Engine** - Scope validation, rate limiting, priority-based task selection, and workflow mapping
- **Cognitive Memory** - LanceDB vector store with Xenova/multilingual-e5-base embeddings for long-term recall across sessions
- **Knowledge Graph** - Static code analysis, dependency mapping, and impact analysis for smarter task execution
- **Discord Control** - Full command interface for monitoring, task dispatch, scheduling, and pair session management
- **Dynamic Scheduling** - Cron-based job scheduler with Discord management commands
- **PR Auto-Improvement** - Monitors open PRs, auto-fixes CI failures, auto-resolves merge conflicts, and retries until all checks pass (conflict detection, AI-powered conflict resolution, CI polling, configurable retry loop)
- **Long-Running Monitors** - Track external processes (training jobs, batch tasks) and report completion
- **Web Dashboard** - Real-time status dashboard on port 3847 with PR Processor monitoring
- **i18n** - English and Korean locale support

## Prerequisites

- **Node.js** >= 22
- **Claude Code CLI** installed and authenticated (`claude -p`)
- **Discord Bot** token with message content intent
- **Linear** API key and team ID
- **GitHub CLI** (`gh`) for CI monitoring (optional)

## Installation

```bash
git clone https://github.com/unohee/OpenSwarm.git
cd OpenSwarm
npm install
```

## Configuration

```bash
cp config.example.yaml config.yaml
```

Create a `.env` file with required secrets:

```bash
DISCORD_TOKEN=your-discord-bot-token
DISCORD_CHANNEL_ID=your-channel-id
LINEAR_API_KEY=your-linear-api-key
LINEAR_TEAM_ID=your-linear-team-id
```

`config.yaml` supports environment variable substitution (`${VAR}` or `${VAR:-default}`) and is validated with Zod schemas.

### Key Configuration Sections

| Section | Description |
|---------|-------------|
| `discord` | Bot token, channel ID, webhook URL |
| `linear` | API key, team ID |
| `github` | Repos list for CI monitoring |
| `agents` | Agent definitions (name, projectPath, heartbeat interval) |
| `autonomous` | Schedule, pair mode, role models, decomposition settings |
| `prProcessor` | PR auto-improvement schedule, retry limits, conflict resolver config |

### Agent Roles

Each pipeline stage can be configured independently:

```yaml
autonomous:
  defaultRoles:
    worker:
      model: claude-haiku-4-5-20251001
      escalateModel: claude-sonnet-4-20250514
      escalateAfterIteration: 3
      timeoutMs: 1800000
    reviewer:
      model: claude-haiku-4-5-20251001
      timeoutMs: 600000
    tester:
      enabled: false
    documenter:
      enabled: false
    auditor:
      enabled: false
```

## Usage

```bash
# Development
npm run dev

# Production
npm run build
npm start

# Background
nohup npm start > openswarm.log 2>&1 &

# Docker
docker compose up -d
```

## Project Structure

```
src/
├── index.ts                 # Entry point
├── core/                    # Config, service lifecycle, types, event hub
├── agents/                  # Worker, reviewer, tester, documenter, auditor
│   ├── pairPipeline.ts      # Worker → Reviewer → Tester → Documenter pipeline
│   ├── agentBus.ts          # Inter-agent message bus
│   └── cliStreamParser.ts   # Claude CLI output parser
├── orchestration/           # Decision engine, task parser, scheduler, workflow
├── automation/              # Autonomous runner, cron scheduler, PR processor
│   ├── autonomousRunner.ts  # Cron-driven heartbeat and task dispatch
│   ├── prProcessor.ts       # PR auto-improvement (CI fixes, conflict resolution)
│   ├── conflictResolver.ts  # AI-powered merge conflict resolution
│   ├── prOwnership.ts       # Bot PR tracking for conflict resolution
│   ├── longRunningMonitor.ts# External process monitoring
│   └── runnerState.ts       # Persistent pipeline state
├── memory/                  # LanceDB + Xenova embeddings cognitive memory
├── knowledge/               # Code knowledge graph (scanner, analyzer, graph)
├── discord/                 # Bot core, command handlers, pair session UI
├── linear/                  # Linear SDK wrapper, project updater
├── github/                  # GitHub CLI wrapper for CI monitoring
├── support/                 # Web dashboard, planner, rollback, git tools
├── locale/                  # i18n (en/ko) with prompt templates
└── __tests__/               # Vitest test suite
```

## Discord Commands

### Task Dispatch
| Command | Description |
|---------|-------------|
| `!dev <repo> "<task>"` | Run a dev task on a repository |
| `!dev list` | List known repositories |
| `!tasks` | List running tasks |
| `!cancel <taskId>` | Cancel a running task |

### Agent Management
| Command | Description |
|---------|-------------|
| `!status` | Agent and system status |
| `!pause <session>` | Pause autonomous work |
| `!resume <session>` | Resume autonomous work |
| `!log <session> [lines]` | View recent output |

### Linear Integration
| Command | Description |
|---------|-------------|
| `!issues` | List Linear issues |
| `!issue <id>` | View issue details |
| `!limits` | Agent daily execution limits |

### Autonomous Execution
| Command | Description |
|---------|-------------|
| `!auto` | Execution status |
| `!auto start [cron] [--pair]` | Start autonomous mode |
| `!auto stop` | Stop autonomous mode |
| `!auto run` | Trigger immediate heartbeat |
| `!approve` / `!reject` | Approve or reject pending task |

### Worker/Reviewer Pair
| Command | Description |
|---------|-------------|
| `!pair` | Pair session status |
| `!pair start [taskId]` | Start a pair session |
| `!pair run <taskId> [project]` | Direct pair run |
| `!pair stop [sessionId]` | Stop a pair session |
| `!pair history [n]` | View session history |
| `!pair stats` | View pair statistics |

### Scheduling
| Command | Description |
|---------|-------------|
| `!schedule` | List all schedules |
| `!schedule run <name>` | Run a schedule immediately |
| `!schedule toggle <name>` | Enable/disable a schedule |
| `!schedule add <name> <path> <interval> "<prompt>"` | Add a schedule |
| `!schedule remove <name>` | Remove a schedule |

### Other
| Command | Description |
|---------|-------------|
| `!ci` | GitHub CI failure status |
| `!codex` | Recent session records |
| `!memory search "<query>"` | Search cognitive memory |
| `!help` | Full command reference |

## How It Works

### Issue Processing Flow

```
Linear (Todo/In Progress)
  → Fetch assigned issues
  → DecisionEngine filters & prioritizes
  → Resolve project path via projectMapper
  → PairPipeline.run()
    → Worker generates code (Claude CLI)
    → Reviewer evaluates (APPROVE/REVISE/REJECT)
    → Loop up to N iterations
    → Optional: Tester → Documenter stages
  → Update Linear issue state (Done/Blocked)
  → Report to Discord
  → Save to cognitive memory
```

### Memory System

Hybrid retrieval scoring: `0.55 * similarity + 0.20 * importance + 0.15 * recency + 0.10 * frequency`

Memory types: `belief`, `strategy`, `user_model`, `system_pattern`, `constraint`

Background cognition: decay, consolidation, contradiction detection, and distillation (noise filtering).

## Tech Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript (strict mode) |
| Build | tsc |
| Agent Execution | Claude Code CLI (`claude -p`) via `child_process.spawn` |
| Task Management | Linear SDK (`@linear/sdk`) |
| Communication | Discord.js 14 |
| Vector DB | LanceDB + Apache Arrow |
| Embeddings | Xenova/transformers (multilingual-e5-base, 768D) |
| Scheduling | Croner |
| Config | YAML + Zod validation |
| Linting | oxlint |
| Testing | Vitest |

## State & Data

| Path | Description |
|------|-------------|
| `~/.openswarm/` | State directory (memory, codex, metrics, workflows, etc.) |
| `~/.claude/openswarm-*.json` | Pipeline history and task state |
| `config.yaml` | Main configuration |
| `dist/` | Compiled output |

## Docker

```bash
docker compose up -d
```

The Docker setup includes volume mounts for `~/.openswarm/` state persistence and `.env` for secrets.

## License

MIT
