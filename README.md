# opencode-ace

Self-improving playbooks for OpenCode. Based on [ACE (Agentic Context Engineering)](https://arxiv.org/abs/2510.04618) and [Meta-Harness](https://arxiv.org/abs/2603.28052).

## What it does

Drop this plugin into any project and your agent gets smarter over time:

1. **Traces** — Every tool execution is logged automatically
2. **Reflects** — After sessions, the LLM extracts lessons from what worked and what didn't
3. **Curates** — Lessons become structured "bullets" in a playbook (strategies, pitfalls, domain knowledge, tool patterns)
4. **Injects** — The playbook is injected into chat context so the agent benefits from accumulated knowledge
5. **Refines** — Bullets are scored, deduplicated, and pruned as the playbook grows

No manual intervention. The harness improves itself.

## Install

Into any project using [OpenCode](https://opencode.ai):

```bash
# Option 1: degit (clean copy, no git history)
npx degit k-nrd/opencode-ace .opencode/plugins/opencode-ace
cd .opencode/plugins/opencode-ace && npm install

# Option 2: git clone
git clone https://github.com/k-nrd/opencode-ace.git .opencode/plugins/opencode-ace
cd .opencode/plugins/opencode-ace && npm install
```

OpenCode auto-loads plugins from `.opencode/plugins/`. No config needed.

### Run tests

```bash
bun test
```

## Usage

### First time

```
> Initialize ACE for this project
```

Calls `ace_init`. Creates `.opencode/ace/` with an empty playbook.

### Seed with existing knowledge (optional)

```
> Initialize ACE with these seed bullets:
  [{"content": "Always check returncode after subprocess.run()", "category": "pitfall"},
   {"content": "Use --no-cache-dir with pip install in Docker", "category": "strategy"}]
```

### Then just work normally

The plugin hooks run automatically:
- `tool.execute.after` → logs traces
- `experimental.chat.system.transform` → injects playbook into context
- `experimental.session.compacting` → preserves playbook across compaction
- `session.idle` → runs reflect→curate cycle

### Trigger reflection

Reflection can be triggered manually when you want:

```
> Reflect on recent traces and update the playbook
```

Or add a manual insight:

```
> ace_reflect with custom_insight "pitfall:The API returns 200 even on validation errors, always check the response body"
```

### Monitor

```
> Show ACE status
```

Shows bullet counts by category, top-scoring bullets, reflection stats.

## How it works

### The playbook

A JSON file at `.opencode/ace/playbook.json` containing structured bullets:

```json
{
  "id": "a1b2c3d4",
  "content": "When editing Rust files, run cargo check after each edit to catch borrow errors early",
  "category": "strategy",
  "helpful_count": 5,
  "harmful_count": 0,
  "tags": ["rust", "compilation"]
}
```

Each bullet is individually tracked. Helpful/harmful counters are updated by the Reflector.

### Deduplication

Uses trigram Jaccard similarity (no embedding model required). When bullets exceed 80% of `max_bullets`, similar bullets are merged and low-scoring ones are pruned.

### Grow-and-refine (from ACE paper)

Instead of monolithic prompt rewriting (which causes "context collapse"), bullets are:
- **Added** incrementally as deltas
- **Updated** in place (counters only)
- **Merged** when similar (keeping the higher-scoring version)
- **Pruned** when net score falls below threshold

This prevents the information loss that plagues other context adaptation methods.

## Filesystem

```
.opencode/ace/
  playbook.json          — The structured playbook
  traces/
    2026-04-06.jsonl     — Tool execution traces (one per day)
  reflections/
    2026-04-06T...json   — Reflection results with reasoning
```

## Config

Set via `ace_init` args or edit `playbook.json` directly:

| Key | Default | Description |
|-----|---------|-------------|
| `max_bullets` | 200 | Dedup/prune triggers at 80% of this |
| `dedup_threshold` | 0.85 | Trigram similarity threshold for merging |
| `prune_threshold` | -2 | Min net score (helpful - harmful) to keep |
| `auto_inject` | true | Inject playbook into chat context |
| `max_inject_tokens` | 8000 | Max injected context size |

## ACE vs Meta-Harness

| | ACE (this plugin) | Meta-Harness |
|---|---|---|
| **Optimizes** | Context/prompts (bullets) | Code (full harness files) |
| **Automation** | Fully automatic | Needs eval runs + proposer |
| **Scope** | Strategies, pitfalls, patterns | Retrieval, orchestration, tool logic |
| **Best for** | Any project, immediate benefit | Benchmark optimization campaigns |

Use this plugin for everyday self-improvement. Use Meta-Harness when you need to optimize the actual harness code against a benchmark.

## License

MIT
