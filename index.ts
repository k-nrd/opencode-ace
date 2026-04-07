/**
 * opencode-ace — Automated harness/context improvement for OpenCode.
 *
 * Implements the ACE (Agentic Context Engineering) loop:
 *   Generator  — runs tasks and notes which strategies helped/hurt
 *   Reflector  — extracts lessons from execution traces
 *   Curator    — merges lessons as structured delta updates into a playbook
 *
 * Combined with Meta-Harness filesystem discipline for full traceability.
 *
 * The playbook is a structured collection of "bullets" — small units of
 * reusable strategy, domain knowledge, or failure patterns — that accumulate
 * and refine over time. Unlike monolithic prompt rewriting, bullets are
 * individually tracked, deduplicated, and pruned.
 *
 * FULLY AUTOMATED: hooks run the reflect→curate cycle after every task.
 * No manual intervention needed — the harness improves itself.
 *
 * Tools:
 *   ace_init       — Initialize an ACE playbook for a project
 *   ace_status     — View playbook state, bullet counts, stats
 *   ace_playbook   — Read/export the current playbook
 *   ace_reset      — Reset or prune the playbook
 *
 * Hooks:
 *   tool.execute.after  — Captures execution outcomes for reflection
 *   chat.message        — Injects playbook into system context
 *   session.idle        — Triggers reflect→curate cycle after task completion
 *   experimental.session.compacting — Preserves playbook awareness in compaction
 */

import { type Plugin, tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"
import * as crypto from "crypto"

// ─── Types ───────────────────────────────────────────────────────────────────

interface Bullet {
  id: string
  content: string
  category: "strategy" | "pitfall" | "domain" | "tool_use" | "pattern"
  helpful_count: number
  harmful_count: number
  created_at: string
  updated_at: string
  source_session: string | null
  tags: string[]
}

interface Playbook {
  version: number
  project: string
  created_at: string
  updated_at: string
  bullets: Bullet[]
  stats: {
    total_sessions: number
    total_reflections: number
    total_bullets_added: number
    total_bullets_pruned: number
    total_bullets_merged: number
  }
  config: PlaybookConfig
}

interface PlaybookConfig {
  /** Max bullets before triggering dedup/prune */
  max_bullets: number
  /** Similarity threshold (0-1) for dedup. Lower = more aggressive. */
  dedup_threshold: number
  /** Min net score (helpful - harmful) before a bullet is pruned */
  prune_threshold: number
  /** Categories to auto-reflect on */
  categories: string[]
  /** Custom reflection prompt override */
  reflection_prompt: string | null
  /** Custom curation prompt override */
  curation_prompt: string | null
  /** Whether to auto-inject playbook into chat context */
  auto_inject: boolean
  /** Max tokens for injected playbook context */
  max_inject_tokens: number
}

interface TraceEntry {
  timestamp: string
  session_id: string | null
  tool: string
  args: Record<string, unknown>
  outcome: string | null
  duration_ms: number | null
}

interface ReflectionResult {
  new_bullets: Omit<Bullet, "id" | "helpful_count" | "harmful_count" | "created_at" | "updated_at" | "source_session">[]
  updated_bullet_ids: { id: string; delta_helpful: number; delta_harmful: number }[]
  reasoning: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ACE_DIR = ".opencode/ace"
const PLAYBOOK_FILE = "playbook.json"
const TRACES_DIR = "traces"
const REFLECTIONS_DIR = "reflections"

const DEFAULT_CONFIG: PlaybookConfig = {
  max_bullets: 200,
  dedup_threshold: 0.85,
  prune_threshold: -2,
  categories: ["strategy", "pitfall", "domain", "tool_use", "pattern"],
  reflection_prompt: null,
  curation_prompt: null,
  auto_inject: true,
  max_inject_tokens: 8000,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function aceDir(directory: string): string {
  return path.join(directory, ACE_DIR)
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function loadPlaybook(directory: string): Playbook | null {
  const p = path.join(aceDir(directory), PLAYBOOK_FILE)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) } catch { return null }
}

function savePlaybook(directory: string, playbook: Playbook): void {
  ensureDir(aceDir(directory))
  playbook.updated_at = new Date().toISOString()
  fs.writeFileSync(
    path.join(aceDir(directory), PLAYBOOK_FILE),
    JSON.stringify(playbook, null, 2)
  )
}

function generateId(): string {
  return crypto.randomBytes(4).toString("hex")
}

/**
 * Cheap text similarity via trigram Jaccard — no embedding model needed.
 * Returns 0-1 where 1 = identical.
 */
function trigramSimilarity(a: string, b: string): number {
  const trigrams = (s: string): Set<string> => {
    const t = new Set<string>()
    const lower = s.toLowerCase().replace(/\s+/g, " ")
    for (let i = 0; i <= lower.length - 3; i++) t.add(lower.slice(i, i + 3))
    return t
  }
  const ta = trigrams(a)
  const tb = trigrams(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let intersection = 0
  for (const t of ta) if (tb.has(t)) intersection++
  return intersection / (ta.size + tb.size - intersection)
}

/**
 * Deduplicate bullets by merging similar ones.
 * Keeps the one with higher net score, sums counters.
 */
function deduplicateBullets(bullets: Bullet[], threshold: number): { kept: Bullet[]; merged: number } {
  const removed = new Set<number>()
  let merged = 0

  for (let i = 0; i < bullets.length; i++) {
    if (removed.has(i)) continue
    for (let j = i + 1; j < bullets.length; j++) {
      if (removed.has(j)) continue
      if (bullets[i].category !== bullets[j].category) continue

      const sim = trigramSimilarity(bullets[i].content, bullets[j].content)
      if (sim >= threshold) {
        // Merge into whichever has higher net score
        const netI = bullets[i].helpful_count - bullets[i].harmful_count
        const netJ = bullets[j].helpful_count - bullets[j].harmful_count
        const [keep, drop] = netI >= netJ ? [i, j] : [j, i]
        bullets[keep].helpful_count += bullets[drop].helpful_count
        bullets[keep].harmful_count += bullets[drop].harmful_count
        bullets[keep].updated_at = new Date().toISOString()
        // Merge tags
        const tagSet = new Set([...bullets[keep].tags, ...bullets[drop].tags])
        bullets[keep].tags = [...tagSet]
        removed.add(drop)
        merged++
      }
    }
  }

  return { kept: bullets.filter((_, i) => !removed.has(i)), merged }
}

/**
 * Prune bullets with net score below threshold.
 */
function pruneBullets(bullets: Bullet[], threshold: number): { kept: Bullet[]; pruned: number } {
  const kept = bullets.filter(b => {
    const net = b.helpful_count - b.harmful_count
    // Keep bullets that haven't been scored yet (both 0) or are above threshold
    return (b.helpful_count === 0 && b.harmful_count === 0) || net > threshold
  })
  return { kept, pruned: bullets.length - kept.length }
}

/**
 * Render the playbook as markdown for injection into chat context.
 */
function renderPlaybook(playbook: Playbook): string {
  if (playbook.bullets.length === 0) return ""

  const grouped = new Map<string, Bullet[]>()
  for (const b of playbook.bullets) {
    const arr = grouped.get(b.category) ?? []
    arr.push(b)
    grouped.set(b.category, arr)
  }

  // Sort within each category by net score descending
  for (const [, arr] of grouped) {
    arr.sort((a, b) => (b.helpful_count - b.harmful_count) - (a.helpful_count - a.harmful_count))
  }

  const sections: string[] = ["## Playbook\n"]

  const categoryLabels: Record<string, string> = {
    strategy: "Strategies",
    pitfall: "Common Pitfalls",
    domain: "Domain Knowledge",
    tool_use: "Tool Usage Patterns",
    pattern: "Patterns & Templates",
  }

  for (const [cat, label] of Object.entries(categoryLabels)) {
    const bullets = grouped.get(cat)
    if (!bullets?.length) continue
    sections.push(`### ${label}\n`)
    for (const b of bullets) {
      const score = b.helpful_count - b.harmful_count
      const indicator = score > 2 ? "★" : score < 0 ? "⚠" : "•"
      sections.push(`${indicator} [${b.id}] ${b.content ?? ""}`)
    }
    sections.push("")
  }

  return sections.join("\n")
}

/**
 * Save a trace entry to disk for later reflection.
 */
function appendTrace(directory: string, entry: TraceEntry): void {
  const dir = path.join(aceDir(directory), TRACES_DIR)
  ensureDir(dir)
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
  fs.appendFileSync(file, JSON.stringify(entry) + "\n")
}

/**
 * Load recent traces (last N entries).
 */
function loadRecentTraces(directory: string, maxEntries = 50): TraceEntry[] {
  const dir = path.join(aceDir(directory), TRACES_DIR)
  if (!fs.existsSync(dir)) return []

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .sort()
    .reverse()

  const entries: TraceEntry[] = []
  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), "utf-8")
      .split("\n")
      .filter(Boolean)
      .reverse()
    for (const line of lines) {
      try { entries.push(JSON.parse(line)) } catch { /* skip */ }
      if (entries.length >= maxEntries) break
    }
    if (entries.length >= maxEntries) break
  }
  return entries
}

/**
 * Build the reflection prompt for the LLM.
 * This is the Reflector step from ACE.
 */
function buildReflectionPrompt(
  traces: TraceEntry[],
  playbook: Playbook,
  customPrompt?: string | null,
): string {
  if (customPrompt) return customPrompt

  const currentBullets = playbook.bullets.length > 0
    ? playbook.bullets.map(b =>
        `[${b.id}] (${b.category}, +${b.helpful_count}/-${b.harmful_count}) ${b.content ?? ""}`
      ).join("\n")
    : "(no bullets yet)"

  const traceStr = traces.map(t =>
    `[${t.timestamp}] tool=${t.tool} outcome=${t.outcome ?? "unknown"}`
  ).join("\n")

  return `You are the Reflector in an ACE (Agentic Context Engineering) loop.

Your job: analyze recent execution traces and extract lessons as structured bullet entries.

## Current Playbook Bullets
${currentBullets}

## Recent Execution Traces
${traceStr}

## Instructions

Analyze the traces above. For each insight you find, output a JSON object with:

1. **new_bullets**: Array of new bullet entries to add. Each has:
   - content: A specific, actionable insight (1-3 sentences)
   - category: One of "strategy", "pitfall", "domain", "tool_use", "pattern"
   - tags: Array of relevant tags

2. **updated_bullet_ids**: Array of existing bullets to update:
   - id: The bullet ID
   - delta_helpful: +1 if this bullet was useful in the traces, 0 otherwise
   - delta_harmful: +1 if this bullet was misleading or wrong, 0 otherwise

3. **reasoning**: Brief explanation of what you learned from the traces.

Rules:
- Be SPECIFIC. "Use error handling" is useless. "Wrap subprocess.run() calls in try/except and check returncode before parsing stdout" is good.
- Don't duplicate existing bullets. Check the current playbook first.
- Mark existing bullets as harmful only if traces show they actively caused problems.
- Focus on ACTIONABLE lessons the agent can immediately apply next time.

Respond with ONLY a JSON object, no markdown fences.`
}

/**
 * Parse a reflection response from the LLM into structured data.
 */
function parseReflection(text: string): ReflectionResult | null {
  try {
    const cleaned = text.replace(/```json\s*|```/g, "").trim()
    const parsed = JSON.parse(cleaned)
    return {
      new_bullets: parsed.new_bullets ?? [],
      updated_bullet_ids: parsed.updated_bullet_ids ?? [],
      reasoning: parsed.reasoning ?? "",
    }
  } catch {
    return null
  }
}

/**
 * Apply a reflection result to the playbook (Curator step).
 * This is the deterministic merge — no LLM needed.
 */
function applyReflection(
  playbook: Playbook,
  reflection: ReflectionResult,
  sessionId: string | null,
): { added: number; updated: number; merged: number; pruned: number } {
  const now = new Date().toISOString()
  let added = 0

  // Add new bullets
  for (const nb of reflection.new_bullets) {
    const bullet: Bullet = {
      id: generateId(),
      content: nb.content ?? "",
      category: nb.category || "strategy",
      helpful_count: 0,
      harmful_count: 0,
      created_at: now,
      updated_at: now,
      source_session: sessionId,
      tags: nb.tags ?? [],
    }
    playbook.bullets.push(bullet)
    added++
  }

  // Update existing bullet counters
  let updated = 0
  for (const upd of reflection.updated_bullet_ids) {
    const bullet = playbook.bullets.find(b => b.id === upd.id)
    if (bullet) {
      bullet.helpful_count += upd.delta_helpful ?? 0
      bullet.harmful_count += upd.delta_harmful ?? 0
      bullet.updated_at = now
      updated++
    }
  }

  // Dedup if over threshold
  let merged = 0
  let pruned = 0
  if (playbook.bullets.length > playbook.config.max_bullets * 0.8) {
    const dedupResult = deduplicateBullets(playbook.bullets, playbook.config.dedup_threshold)
    playbook.bullets = dedupResult.kept
    merged = dedupResult.merged

    const pruneResult = pruneBullets(playbook.bullets, playbook.config.prune_threshold)
    playbook.bullets = pruneResult.kept
    pruned = pruneResult.pruned
  }

  // Update stats
  playbook.stats.total_reflections++
  playbook.stats.total_bullets_added += added
  playbook.stats.total_bullets_merged += merged
  playbook.stats.total_bullets_pruned += pruned

  return { added, updated, merged, pruned }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const ACEPlugin: Plugin = async ({ client, directory, $ }) => {

  // Buffer of trace entries accumulated during the current session
  let sessionTraces: TraceEntry[] = []
  let currentSessionId: string | null = null

  return {

    // ── Custom Tools ────────────────────────────────────────────────────

    tool: {

      ace_init: tool({
        description:
          "Initialize an ACE playbook for this project. Creates the .opencode/ace/ directory " +
          "with a playbook.json that will accumulate strategies, pitfalls, and domain knowledge " +
          "automatically as you work. The playbook improves itself through a Reflector→Curator " +
          "loop that runs after each session.",
        args: {
          project_name: tool.schema.string().optional().describe(
            "Human-readable project name (defaults to directory basename)"
          ),
          max_bullets: tool.schema.number().optional().describe(
            "Max bullet entries before triggering dedup/prune (default: 200)"
          ),
          seed_bullets: tool.schema.string().optional().describe(
            "Optional JSON array of seed bullets to start with. Each: " +
            '{content: string, category: "strategy"|"pitfall"|"domain"|"tool_use"|"pattern", tags: string[]}'
          ),
        },
        async execute(args, context) {
          const existing = loadPlaybook(context.directory)
          if (existing) {
            return `ACE playbook already exists with ${existing.bullets.length} bullets. Use ace_reset to start over.`
          }

          const config: PlaybookConfig = {
            ...DEFAULT_CONFIG,
            ...(args.max_bullets ? { max_bullets: args.max_bullets } : {}),
          }

          const playbook: Playbook = {
            version: 1,
            project: args.project_name ?? path.basename(context.directory),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            bullets: [],
            stats: {
              total_sessions: 0,
              total_reflections: 0,
              total_bullets_added: 0,
              total_bullets_pruned: 0,
              total_bullets_merged: 0,
            },
            config,
          }

          // Add seed bullets if provided
          if (args.seed_bullets) {
            try {
              const seeds = JSON.parse(args.seed_bullets)
              for (const s of seeds) {
                playbook.bullets.push({
                  id: generateId(),
                  content: s.content ?? "",
                  category: s.category ?? "strategy",
                  helpful_count: 0,
                  harmful_count: 0,
                  created_at: playbook.created_at,
                  updated_at: playbook.created_at,
                  source_session: null,
                  tags: s.tags ?? [],
                })
              }
              playbook.stats.total_bullets_added = playbook.bullets.length
            } catch {
              return "Error: invalid seed_bullets JSON."
            }
          }

          ensureDir(path.join(aceDir(context.directory), TRACES_DIR))
          ensureDir(path.join(aceDir(context.directory), REFLECTIONS_DIR))
          savePlaybook(context.directory, playbook)

          return [
            `ACE playbook initialized for "${playbook.project}".`,
            "",
            `Directory: ${aceDir(context.directory)}`,
            `Bullets: ${playbook.bullets.length} (${args.seed_bullets ? "seeded" : "empty"})`,
            `Max bullets: ${config.max_bullets}`,
            "",
            "The playbook will automatically:",
            "1. Capture execution traces during your sessions",
            "2. Inject accumulated strategies into your chat context",
            "3. Reflect on outcomes and extract new bullets after each session",
            "4. Deduplicate and prune bullets as the playbook grows",
          ].join("\n")
        },
      }),

      ace_status: tool({
        description:
          "View the current ACE playbook status: bullet count by category, " +
          "top-scoring bullets, recent reflections, and config.",
        args: {},
        async execute(_args, context) {
          const playbook = loadPlaybook(context.directory)
          if (!playbook) return "No ACE playbook found. Use ace_init to create one."

          const byCategory = new Map<string, number>()
          for (const b of playbook.bullets) {
            byCategory.set(b.category, (byCategory.get(b.category) ?? 0) + 1)
          }

          const topBullets = [...playbook.bullets]
            .sort((a, b) => (b.helpful_count - b.harmful_count) - (a.helpful_count - a.harmful_count))
            .slice(0, 5)

          const recentTraces = loadRecentTraces(context.directory, 10)

          return [
            `# ACE Playbook: ${playbook.project}`,
            "",
            `Total bullets: ${playbook.bullets.length} / ${playbook.config.max_bullets}`,
            "",
            "By category:",
            ...Array.from(byCategory.entries()).map(([k, v]) => `  ${k}: ${v}`),
            "",
            "Top bullets:",
            ...topBullets.map(b => {
              const net = b.helpful_count - b.harmful_count
              return `  [${b.id}] +${b.helpful_count}/-${b.harmful_count} (net ${net}) ${(b.content ?? "").slice(0, 80)}...`
            }),
            "",
            `Sessions: ${playbook.stats.total_sessions}`,
            `Reflections: ${playbook.stats.total_reflections}`,
            `Added/Merged/Pruned: ${playbook.stats.total_bullets_added}/${playbook.stats.total_bullets_merged}/${playbook.stats.total_bullets_pruned}`,
            `Recent traces: ${recentTraces.length}`,
          ].join("\n")
        },
      }),

      ace_playbook: tool({
        description:
          "Read or export the current ACE playbook. Returns the full rendered playbook " +
          "as markdown, or raw JSON for programmatic use.",
        args: {
          format: tool.schema.enum(["markdown", "json"]).optional().describe(
            "Output format (default: markdown)"
          ),
          category: tool.schema.string().optional().describe(
            "Filter by category (strategy, pitfall, domain, tool_use, pattern)"
          ),
        },
        async execute(args, context) {
          const playbook = loadPlaybook(context.directory)
          if (!playbook) return "No ACE playbook found."

          let bullets = playbook.bullets
          if (args.category) {
            bullets = bullets.filter(b => b.category === args.category)
          }

          if (args.format === "json") {
            return JSON.stringify(bullets, null, 2)
          }

          const filtered = { ...playbook, bullets }
          return renderPlaybook(filtered) || "(empty playbook)"
        },
      }),

      ace_reflect: tool({
        description:
          "Manually trigger a reflection cycle. Normally this runs automatically " +
          "after each session, but you can force it to process recent traces immediately. " +
          "Uses the LLM to analyze execution traces and extract new playbook bullets.",
        args: {
          max_traces: tool.schema.number().optional().describe(
            "Max recent traces to reflect on (default: 50)"
          ),
          custom_insight: tool.schema.string().optional().describe(
            "Optional: manually add a specific insight instead of LLM reflection. " +
            "Format: 'category:content' e.g. 'pitfall:Never run rm -rf without confirming the path first'"
          ),
        },
        async execute(args, context) {
          const playbook = loadPlaybook(context.directory)
          if (!playbook) return "No ACE playbook found."

          // Manual insight shortcut
          if (args.custom_insight) {
            const colonIdx = args.custom_insight.indexOf(":")
            if (colonIdx === -1) return "Format: 'category:content'"
            const category = args.custom_insight.slice(0, colonIdx).trim() as Bullet["category"]
            const content = args.custom_insight.slice(colonIdx + 1).trim()
            const validCats = ["strategy", "pitfall", "domain", "tool_use", "pattern"]
            if (!validCats.includes(category)) return `Invalid category. Use: ${validCats.join(", ")}`

            const bullet: Bullet = {
              id: generateId(),
              content,
              category,
              helpful_count: 0,
              harmful_count: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              source_session: null,
              tags: [],
            }
            playbook.bullets.push(bullet)
            playbook.stats.total_bullets_added++
            savePlaybook(context.directory, playbook)
            return `Added bullet [${bullet.id}]: ${content}`
          }

          // LLM reflection
          const traces = loadRecentTraces(context.directory, args.max_traces ?? 50)
          if (traces.length === 0) return "No traces to reflect on yet. Work on some tasks first."

          const prompt = buildReflectionPrompt(traces, playbook, playbook.config.reflection_prompt)

          // Call the LLM via the OpenCode SDK
          try {
            const response = await client.session.prompt({
              path: { id: currentSessionId ?? "default" },
              body: {
                system: prompt,
                parts: [{ type: "text", text: "Reflect on the execution traces and extract playbook bullets." }],
              },
            })

            // Extract text from response
            const responseText = typeof response === "string"
              ? response
              : JSON.stringify(response)

            const reflection = parseReflection(responseText)
            if (!reflection) {
              return "Reflection produced unparseable output. Saving raw response for debugging.\n\n" + responseText.slice(0, 500)
            }

            const result = applyReflection(playbook, reflection, currentSessionId)
            savePlaybook(context.directory, playbook)

            // Log the reflection
            const reflPath = path.join(
              aceDir(context.directory), REFLECTIONS_DIR,
              `${new Date().toISOString().replace(/[:.]/g, "-")}.json`
            )
            fs.writeFileSync(reflPath, JSON.stringify({
              timestamp: new Date().toISOString(),
              traces_analyzed: traces.length,
              reflection,
              result,
            }, null, 2))

            return [
              "Reflection complete.",
              "",
              `Traces analyzed: ${traces.length}`,
              `Bullets added: ${result.added}`,
              `Bullets updated: ${result.updated}`,
              `Bullets merged (dedup): ${result.merged}`,
              `Bullets pruned: ${result.pruned}`,
              `Total bullets: ${playbook.bullets.length}`,
              "",
              `Reasoning: ${reflection.reasoning}`,
            ].join("\n")
          } catch (err) {
            return `Reflection failed: ${err}`
          }
        },
      }),

      ace_reset: tool({
        description: "Reset the ACE playbook. Use 'soft' to prune low-scoring bullets, or 'hard' to delete everything.",
        args: {
          mode: tool.schema.enum(["soft", "hard"]).describe(
            "'soft' prunes bullets with net score below threshold. 'hard' deletes everything."
          ),
        },
        async execute(args, context) {
          if (args.mode === "hard") {
            const dir = aceDir(context.directory)
            if (fs.existsSync(dir)) {
              fs.rmSync(dir, { recursive: true })
            }
            return "ACE playbook deleted. Use ace_init to start fresh."
          }

          const playbook = loadPlaybook(context.directory)
          if (!playbook) return "No ACE playbook found."

          const before = playbook.bullets.length
          const { kept, pruned } = pruneBullets(playbook.bullets, playbook.config.prune_threshold)
          const { kept: deduped, merged } = deduplicateBullets(kept, playbook.config.dedup_threshold)
          playbook.bullets = deduped
          playbook.stats.total_bullets_pruned += pruned
          playbook.stats.total_bullets_merged += merged
          savePlaybook(context.directory, playbook)

          return `Soft reset: ${before} → ${deduped.length} bullets (pruned ${pruned}, merged ${merged})`
        },
      }),
    },

    // ── Config ─────────────────────────────────────────────────────────

    config: async (input) => {
      input.command = input.command ?? {}
      input.command["ace-init"] = {
        template: "Run the ace_init tool to initialize an ACE playbook. $ARGUMENTS",
        description: "Initialize ACE playbook",
      }
      input.command["ace-status"] = {
        template: "Run the ace_status tool and show the results.",
        description: "View ACE playbook status",
      }
      input.command["ace-playbook"] = {
        template: "Run the ace_playbook tool. Format: $1, Category: $2",
        description: "Read/export ACE playbook",
      }
      input.command["ace-reflect"] = {
        template: "Run the ace_reflect tool. $ARGUMENTS",
        description: "Trigger ACE reflection cycle",
      }
      input.command["ace-reset"] = {
        template: 'Run the ace_reset tool with mode "$1". Default to soft if not specified.',
        description: "Reset ACE playbook (soft/hard)",
      }
    },

    // ── Hooks ──────────────────────────────────────────────────────────

    /**
     * Track tool executions as traces for later reflection.
     */
    "tool.execute.after": async (input, output) => {
      const playbook = loadPlaybook(directory)
      if (!playbook) return

      const entry: TraceEntry = {
        timestamp: new Date().toISOString(),
        session_id: currentSessionId,
        tool: input.tool,
        args: input.args ?? {},
        outcome: typeof output.output === "string" ? output.output.slice(0, 500) : null,
        duration_ms: null,
      }

      sessionTraces.push(entry)
      appendTrace(directory, entry)
    },

    /**
     * Track session lifecycle for stats.
     */
    event: async ({ event }) => {
      if (event.type === "session.created") {
        currentSessionId = (event as any).properties?.id ?? generateId()
        sessionTraces = []
        const playbook = loadPlaybook(directory)
        if (playbook) {
          playbook.stats.total_sessions++
          savePlaybook(directory, playbook)
        }
      }

      // Auto-reflect at end of every session
      if (event.type === "session.idle") {
        const playbook = loadPlaybook(directory)
        if (!playbook || sessionTraces.length === 0) return

        const traces = loadRecentTraces(directory, 50)
        if (traces.length === 0) return

        const prompt = buildReflectionPrompt(traces, playbook, playbook.config.reflection_prompt)

        try {
            const response = await client.session.prompt({
              path: { id: currentSessionId ?? "default" },
              body: {
                system: prompt,
                parts: [{ type: "text", text: "Reflect on the execution traces and extract playbook bullets." }],
              },
            })

          const responseText = typeof response === "string"
            ? response
            : JSON.stringify(response)

          const reflection = parseReflection(responseText)
          if (!reflection) return

          const result = applyReflection(playbook, reflection, currentSessionId)
          savePlaybook(directory, playbook)

          // Log the reflection
          const reflPath = path.join(
            aceDir(directory), REFLECTIONS_DIR,
            `${new Date().toISOString().replace(/[:.]/g, "-")}.json`
          )
          fs.writeFileSync(reflPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            session_id: currentSessionId,
            traces_analyzed: traces.length,
            reflection,
            result,
          }, null, 2))

          await client.app.log({
            body: {
              service: "opencode-ace",
              level: "info",
              message: `Reflection complete: +${result.added} bullets, ${result.pruned} pruned`,
              extra: result,
            },
          })
        } catch {
          // Silent failure — don't break session teardown
        }

        sessionTraces = []
      }
    },

    /**
     * Inject the playbook into system context so the agent benefits from
     * accumulated knowledge. This is the Generator's input enrichment.
     */
    "experimental.chat.system.transform": async (_input, output) => {
      const playbook = loadPlaybook(directory)
      if (!playbook || !playbook.config.auto_inject || playbook.bullets.length === 0) return

      let rendered = renderPlaybook(playbook)
      if (!rendered) return

      if (rendered.length / 4 > playbook.config.max_inject_tokens) {
        const sorted = [...playbook.bullets]
          .sort((a, b) => (b.helpful_count - b.harmful_count) - (a.helpful_count - a.harmful_count))
        const truncated: Playbook = { ...playbook, bullets: sorted.slice(0, 50) }
        rendered = renderPlaybook(truncated)
      }

      output.system.push(rendered)
    },

    /**
     * Preserve playbook context across session compaction.
     */
    "experimental.session.compacting": async (_input, output) => {
      const playbook = loadPlaybook(directory)
      if (!playbook) return

      output.context.push(`
## ACE Playbook State
Project: ${playbook.project}
Bullets: ${playbook.bullets.length}
Sessions: ${playbook.stats.total_sessions}
Reflections: ${playbook.stats.total_reflections}

The ACE playbook is automatically injected into context. Use ace_status for details.
Top strategies are preserved and accumulate over time.
`)
    },
  }
}
export default ACEPlugin
