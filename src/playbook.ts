import * as path from "path"
import * as fs from "fs"
import * as crypto from "crypto"
import type { Bullet, Playbook, PlaybookConfig, TraceEntry, ReflectionResult, RenderOptions } from "./types.js"

export const ACE_DIR = ".opencode/ace"
export const PLAYBOOK_FILE = "playbook.json"
export const TRACES_DIR = "traces"
export const REFLECTIONS_DIR = "reflections"

export const DEFAULT_CONFIG: PlaybookConfig = {
  max_bullets: 200,
  dedup_threshold: 0.85,
  prune_threshold: -2,
  categories: ["strategy", "pitfall", "domain", "tool_use", "pattern"],
  reflection_prompt: null,
  curation_prompt: null,
  auto_inject: true,
  max_inject_tokens: 4000,
  min_score_to_inject: 1,
  max_reflection_rounds: 3,
  min_traces_for_reflection: 5,
  stale_bullet_ttl_days: 14,
  inject_categories: ["pitfall", "domain"],
  tag_matching: true,
}

export function aceDir(directory: string): string {
  return path.join(directory, ACE_DIR)
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function generateId(): string {
  return crypto.randomBytes(4).toString("hex")
}

let playbookCache: Map<string, { playbook: Playbook; mtime: number }> = new Map()

function getPlaybookPath(directory: string): string {
  return path.join(aceDir(directory), PLAYBOOK_FILE)
}

export function loadPlaybook(directory: string): Playbook | null {
  const p = getPlaybookPath(directory)
  if (!fs.existsSync(p)) {
    playbookCache.delete(directory)
    return null
  }
  try {
    const stat = fs.statSync(p)
    const cached = playbookCache.get(directory)
    if (cached && cached.mtime === stat.mtimeMs) return cached.playbook
    const playbook = JSON.parse(fs.readFileSync(p, "utf-8")) as Playbook
    playbookCache.set(directory, { playbook, mtime: stat.mtimeMs })
    return playbook
  } catch {
    playbookCache.delete(directory)
    return null
  }
}

export function savePlaybook(directory: string, playbook: Playbook): void {
  ensureDir(aceDir(directory))
  playbook.updated_at = new Date().toISOString()
  const p = getPlaybookPath(directory)
  fs.writeFileSync(p, JSON.stringify(playbook, null, 2))
  playbookCache.delete(directory)
}

export function estimateTokens(text: string): number {
  const symbolCount = (text.match(/[^a-zA-Z0-9\s]/g) || []).length
  const ratio = symbolCount / text.length > 0.15 ? 2.8 : 3.5
  return Math.ceil(text.length / ratio)
}

export function trigramSimilarity(a: string, b: string): number {
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

export function deduplicateBullets(bullets: Bullet[], threshold: number): { kept: Bullet[]; merged: number } {
  const removed = new Set<number>()
  let merged = 0

  for (let i = 0; i < bullets.length; i++) {
    if (removed.has(i)) continue
    for (let j = i + 1; j < bullets.length; j++) {
      if (removed.has(j)) continue
      if (bullets[i].category !== bullets[j].category) continue

      const sim = trigramSimilarity(bullets[i].content, bullets[j].content)
      if (sim >= threshold) {
        const netI = bullets[i].helpful_count - bullets[i].harmful_count
        const netJ = bullets[j].helpful_count - bullets[j].harmful_count
        const [keep, drop] = netI >= netJ ? [i, j] : [j, i]
        bullets[keep].helpful_count += bullets[drop].helpful_count
        bullets[keep].harmful_count += bullets[drop].harmful_count
        bullets[keep].updated_at = new Date().toISOString()
        const tagSet = new Set([...bullets[keep].tags, ...bullets[drop].tags])
        bullets[keep].tags = [...tagSet]
        removed.add(drop)
        merged++
      }
    }
  }

  return { kept: bullets.filter((_, i) => !removed.has(i)), merged }
}

export function pruneBullets(bullets: Bullet[], threshold: number, staleDays: number = 14): { kept: Bullet[]; pruned: number } {
  const now = Date.now()
  const staleMs = staleDays * 24 * 60 * 60 * 1000
  const kept = bullets.filter(b => {
    const net = b.helpful_count - b.harmful_count
    if (b.helpful_count === 0 && b.harmful_count === 0) {
      const age = now - new Date(b.created_at).getTime()
      return age < staleMs
    }
    return net > threshold
  })
  return { kept, pruned: bullets.length - kept.length }
}

export function renderPlaybook(playbook: Playbook, options?: RenderOptions): string {
  let bullets = playbook.bullets
  if (bullets.length === 0) return ""

  const opts = options ?? {}
  const minScore = opts.minScore ?? -Infinity
  const tags = opts.tags
  const alwaysCategories = new Set(opts.alwaysCategories ?? [])

  const filtered = bullets.filter(b => {
    const net = b.helpful_count - b.harmful_count
    if (net < minScore) return false
    if (alwaysCategories.has(b.category)) return true
    if (tags && tags.size > 0 && b.tags.length > 0) {
      return b.tags.some(t => tags.has(t))
    }
    if (tags && tags.size > 0 && b.tags.length === 0) return false
    return true
  })

  if (filtered.length === 0) return ""

  const grouped = new Map<string, Bullet[]>()
  for (const b of filtered) {
    const arr = grouped.get(b.category) ?? []
    arr.push(b)
    grouped.set(b.category, arr)
  }

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
    const catBullets = grouped.get(cat)
    if (!catBullets?.length) continue
    sections.push(`### ${label}\n`)
    for (const b of catBullets) {
      const score = b.helpful_count - b.harmful_count
      const indicator = score > 2 ? "★" : score < 0 ? "⚠" : "•"
      sections.push(`${indicator} [${b.id}] ${b.content ?? ""}`)
    }
    sections.push("")
  }

  return sections.join("\n")
}

export function renderGeneratorInstructions(): string {
  return `## ACE: Reporting Bullet Impact

You have a playbook of strategic bullets injected into your context. After every meaningful task, you MUST report which bullets influenced your decisions by calling ace_feedback so the playbook self-improves.

### Signal Matrix

Use: ace_feedback(bullet_id="...", rating="helpful"|"harmful", strength=1-3, note="...")

                 positive    negative
very strong         +3          -3
strong              +2          -2
weak                +1          -1

### Reaction → Strength Mapping

VERY STRONG POSITIVE (strength=3): MUST use when user says "Perfect!" / "Exactly what I wanted" / "You're a lifesaver"
STRONG POSITIVE (strength=2): MUST use when user says "Thanks" / "That worked" / "Looks good" / "Done"
WEAK POSITIVE (strength=1): SHOULD use when user moves on without complaint after non-trivial work

WEAK NEGATIVE (strength=1): MUST use when user says "Almost..." / "One small thing..." / minor tweak
STRONG NEGATIVE (strength=2): MUST use when user says "No that's wrong" / "Try again" / "Not what I asked for"
VERY STRONG NEGATIVE (strength=3): MUST use when user says "Undo that" / reverts a file / failed same task 3+ times

### Attribution Rules

You MUST call ace_feedback at natural checkpoints: task completion, user rejection, or after a retry.
You SHOULD rate 1-3 bullets you actually read and used in your reasoning for this task.
You MUST NOT rate bullets you ignored or that were irrelevant to the task.
If no bullets were relevant, you MUST skip silently — do NOT fabricate feedback.
Strength measures signal confidence, not magnitude. "Harmful" with strength=3 is accurate and necessary.
You MUST NOT announce what you are doing — call the tool and continue immediately.`
}

export function extractFileExtension(args: Record<string, unknown>): string | null {
  const filePath = args.filePath ?? args.path ?? args.file ?? null
  if (typeof filePath !== "string") return null
  const ext = filePath.split(".").pop()?.toLowerCase() ?? null
  return ext && ext.length <= 10 ? ext : null
}

export function detectErrorSignal(outcome: string | null): boolean {
  if (!outcome) return false
  const lower = outcome.toLowerCase()
  return lower.includes("error") || lower.includes("fail") || lower.includes("exception") || lower.includes("traceback") || lower.includes("fatal") || lower.includes("denied") || lower.includes("not found") || lower.includes("cannot") || lower.includes("unable to")
}

export function cleanupOldTraces(directory: string, maxAgeDays: number = 30): void {
  const dir = path.join(aceDir(directory), TRACES_DIR)
  if (!fs.existsSync(dir)) return
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"))) {
    const dateStr = file.replace(".jsonl", "")
    const fileDate = new Date(dateStr).getTime()
    if (!isNaN(fileDate) && fileDate < cutoff) {
      fs.unlinkSync(path.join(dir, file))
    }
  }
}

export function applyImplicitFeedback(
  playbook: Playbook,
  trace: TraceEntry,
  previousToolCall: { tool: string; timestamp: string } | null,
  _directory: string,
): void {
  if (!trace.error_signal && !trace.is_retry) return

  const recentBullets = playbook.bullets.filter(b => {
    const age = Date.now() - new Date(b.created_at).getTime()
    return age < 24 * 60 * 60 * 1000
  })

  const traceExt = trace.file_extension
  for (const bullet of recentBullets) {
    if (traceExt && bullet.tags.includes(traceExt)) {
      bullet.harmful_count += 1
      bullet.updated_at = new Date().toISOString()
    }
  }
}

export function appendTrace(directory: string, entry: TraceEntry): void {
  const dir = path.join(aceDir(directory), TRACES_DIR)
  ensureDir(dir)
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
  fs.appendFileSync(file, JSON.stringify(entry) + "\n")
}

export function loadRecentTraces(directory: string, maxEntries = 50): TraceEntry[] {
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

export function buildReflectionPrompt(
  traces: TraceEntry[],
  playbook: Playbook,
  customPrompt?: string | null,
  round?: number,
): string {
  if (customPrompt) return customPrompt

  const currentBullets = playbook.bullets.length > 0
    ? playbook.bullets.map(b =>
        `[${b.id}] (${b.category}, +${b.helpful_count}/-${b.harmful_count}) ${b.content ?? ""}`
      ).join("\n")
    : "(no bullets yet)"

  const traceStr = traces.map(t => {
    const argsStr = t.args
      ? Object.entries(t.args)
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 120) : JSON.stringify(v).slice(0, 120)}`)
          .join(" ")
      : ""
    const signals: string[] = []
    if (t.error_signal) signals.push("ERROR")
    if (t.is_retry) signals.push("RETRY")
    if (t.exit_code != null && t.exit_code !== 0) signals.push(`EXIT=${t.exit_code}`)
    const signalStr = signals.length > 0 ? ` [${signals.join(",")}]` : ""
    return `[${t.timestamp}] tool=${t.tool} ${argsStr} outcome=${t.outcome?.slice(0, 200) ?? "unknown"}${signalStr}`
  }).join("\n")

  const roundInstruction = (round ?? 0) > 0
    ? `\n\n## Refinement Round ${round}\nYou previously extracted bullets from these traces. Re-examine your output. Remove any that are vague, generic, or duplicate existing bullets. Improve any that could be more specific. If no improvements are needed, return empty new_bullets.`
    : ""

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
   - tags: Array of relevant tags (include file extensions like "ts", "py", file paths like "src/", and concepts like "testing", "error-handling")

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
- Tag every bullet with relevant file extensions and concepts so the system can inject the right bullets for the right context.
${roundInstruction}

Respond with ONLY a JSON object, no markdown fences.`
}

export function applyReflection(
  playbook: Playbook,
  reflection: ReflectionResult,
  sessionId: string | null,
): { added: number; updated: number; merged: number; pruned: number } {
  const now = new Date().toISOString()
  let added = 0

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

  let merged = 0
  let pruned = 0
  if (playbook.bullets.length > playbook.config.max_bullets * 0.8) {
    const dedupResult = deduplicateBullets(playbook.bullets, playbook.config.dedup_threshold)
    playbook.bullets = dedupResult.kept
    merged = dedupResult.merged

    const pruneResult = pruneBullets(playbook.bullets, playbook.config.prune_threshold, playbook.config.stale_bullet_ttl_days ?? 14)
    playbook.bullets = pruneResult.kept
    pruned = pruneResult.pruned
  }

  playbook.stats.total_reflections++
  playbook.stats.total_bullets_added += added
  playbook.stats.total_bullets_merged += merged
  playbook.stats.total_bullets_pruned += pruned

  return { added, updated, merged, pruned }
}
