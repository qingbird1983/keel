# Keel

**English** · [简体中文](README.zh-CN.md)

**A governance-oriented runtime kernel for Agent Harnesses: control, isolation, ledger, compensation and context governance as kernel primitives — long-running agents stay non-bypassable in control, non-cascading in failure, and non-silent in side effects.**

Changelog: [CHANGELOG.md](CHANGELOG.md) · License: [LICENSE](LICENSE)

## Highlights

- **Five invariants as kernel primitives**: control non-bypassable / failures non-cascading / state non-lossy / side effects non-silent / context non-globally-polluting
- **Watertight-compartment execution units (Cells)**: each agent run owns a private tool table, memory and context — one flooded compartment does not sink the ship
- **Append-only execution ledger**: every decision round is replayable and auditable; long-running tasks resume from consistency points
- **Plugins assemble capabilities, not control**: capability / policy / observation plugins each in their place; hot assembly switches to a new Cell instead of mutating a global registry
- Docs-first engineering — design docs, ADRs, standards and a phased roadmap are committed before any code (see [`docs/`](docs/README.md)).

## Status

Phase 0 (design baseline) complete — four key designs finalized, six decision records, MIT license in place; Phase 1 (MVP) scope contract finalized, about to start.

- **Roadmap & progress board**: [docs/roadmap/00-roadmap.md](docs/roadmap/00-roadmap.md)

## Documentation

Project documentation is maintained in **Chinese** under [`docs/`](docs/README.md) (this README pair is the bilingual entry point):

| Directory                                  | Contents                                                             |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [`docs/research/`](docs/research/)         | Research notes: facts and data behind decisions                      |
| [`docs/adr/`](docs/adr/)                   | Decision records — why things are the way they are                   |
| [`docs/architecture/`](docs/architecture/) | System design and key constraints                                    |
| [`docs/roadmap/`](docs/roadmap/)           | Phases, scope, acceptance scenarios; `00-roadmap.md` hosts the board |
| [`docs/standards/`](docs/standards/)       | 9 repo standards: how work gets done                                 |
| [`docs/design/`](docs/design/)             | Per-phase detailed designs and progress reports                      |
| [`docs/glossary.md`](docs/glossary.md)     | Glossary (for non-technical readers)                                 |

## License

[MIT](LICENSE) © 2026 qingbird1983 (attribution decided in ADR-0007)
