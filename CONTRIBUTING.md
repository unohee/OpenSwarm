# Contributing to OpenSwarm

Thank you for your interest in OpenSwarm. OpenSwarm is [MIT-licensed](LICENSE) and welcomes
pull requests, bug reports, and ideas from everyone. This document covers both **how to
contribute code** (setup, checks, PR flow) and the **community guidelines** for issues and
conduct.

### Ways to contribute

- 🐛 **Bug reports** — open a [bug report](https://github.com/unohee/OpenSwarm/issues/new?template=bug_report.md)
- 💡 **Feature ideas** — start a [Discussion](https://github.com/unohee/OpenSwarm/discussions); the roadmap is built in the open
- 🔧 **Code** — see [Development setup](#development-setup) below, then send a PR
- 📖 **Docs** — typo fixes and clarifications are always welcome

## Issues

### Allowed

- **Bug reports**: Clear description of the bug, steps to reproduce, expected vs actual behavior.
- **Feature requests**: Describe the problem you're facing within OpenSwarm and propose a solution.
- **Technical discussions**: Architecture decisions, design trade-offs, or implementation questions directly related to OpenSwarm.

### Not Allowed

- **Product promotion**: Issues that primarily serve to advertise an external product, service, or library are not accepted. This includes framing a feature request around a specific external tool as the only or default solution.
- **Unsolicited integration proposals for commercial or self-hosted services**: If you want to propose integrating an external tool, the issue must clearly define the problem independent of that tool and present at least one alternative approach that does not depend on it.
- **Drive-by self-promotion in comments**: Do not post links to your own projects, repositories, or products in issue threads unless they are directly relevant to solving a problem under active discussion. Dropping links with minimal context to increase visibility for your project will be treated as spam.

### Conflict of Interest Disclosure

If you propose a feature, integration, or architectural change that involves a project you maintain or a product you are affiliated with, you **must** disclose that relationship explicitly at the top of your issue or comment. Failure to disclose will result in the issue or comment being closed.

Example:

> **Disclosure**: I am the maintainer of [project-name]. This proposal involves integration with that project.

## Development setup

Prerequisites:

- **Node.js >= 22**, `git`
- A **C/C++ toolchain** for the native modules (`better-sqlite3`, `@lancedb/lancedb`).
  Prebuilt binaries cover common platforms; if yours lacks one, `npm install` builds from
  source and needs `python3` plus `build-essential` (Linux) or the Xcode Command Line
  Tools (macOS).

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/<your-username>/OpenSwarm.git
cd OpenSwarm
npm install
npm run build
```

You do **not** need a `config.yaml` or any LLM provider to run the test suite — it is
fully self-contained. The codebase layout is documented in the
[Project Structure](README.md#project-structure) section of the README.

## Before you open a PR

Run the same gates CI runs:

```bash
npm run lint        # oxlint
npm run typecheck   # tsc --noEmit
npm run build       # tsc
npm test            # vitest
# shortcut for the first three: npm run ci
```

CI (`.github/workflows/ci.yml`) runs **lint → typecheck → build → test** on every PR to
`main`. Lint, typecheck, and build must pass; keep tests green and add coverage for new
behavior. Files over 800 lines trigger a CI warning — prefer smaller, focused modules.

## Branch & commit conventions

- Branch from `main`. Name branches `feature/<short-desc>` or `fix/<short-desc>`.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(scope): …`, `fix(scope): …`, `docs: …`, `refactor: …`, `chore: …`, `test: …`.

## Pull Requests

- PRs should reference an existing issue. If there is no issue, open one first for discussion before submitting code.
- Keep PRs focused. One PR per concern.
- Include tests where applicable, and update docs when behavior changes.
- Follow the existing code style and project structure.

Steps:

1. Fork the repo and create your branch from `main`.
2. Make your change and ensure the local checks above pass.
3. Open a PR against `main`, fill in the PR template, and link the related issue
   (e.g. `Closes #123`).
4. A maintainer reviews and may request changes. Once CI is green and the review is
   approved, the PR is squash-merged.

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE), and you confirm you have the right to submit them.

## Conduct

- Speak as yourself. Do not use "we" to imply authority or affiliation with OpenSwarm unless you are a listed maintainer.
- Engage with the substance of discussions, not to position your own projects.
- Respect the maintainer's time. This is an open-source project, not a marketplace.

## Enforcement

The maintainer reserves the right to close, lock, or delete any issue, comment, or PR that violates these guidelines without prior notice.
