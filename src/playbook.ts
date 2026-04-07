import * as path from "path"
import * as fs from "fs"
import * as crypto from "crypto"
import type { Bullet, Playbook, PlaybookConfig, TraceEntry, ReflectionResult } from "./types.js"

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
  max_inject_tokens: 8000,
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

export function loadPlaybook(directory: string): Playbook | null {
  const p = path.join(aceDir(directory), PLAYBOOK_FILE)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) } catch { return null }
}

export function savePlaybook(directory: string, playbook: Playbook): void {
  ensureDir(aceDir(directory))
  playbook.updated_at = new Date().toISOString()
  fs.writeFileSync(
    path.join(aceDir(directory), PLAYBOOK_FILE),
    JSON.stringify(playbook, null, 2),
  )
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

export function pruneBullets(bullets: Bullet[], threshold: number): { kept: Bullet[]; pruned: number } {
  const kept = bullets.filter(b => {
    const net = b.helpful_count - b.harmful_count
    return (b.helpful_count === 0 && b.harmful_count === 0) || net > threshold
  })
  return { kept, pruned: bullets.length - kept.length }
}

export function renderPlaybook(playbook: Playbook): string {
  if (playbook.bullets.length === 0) return ""

  const grouped = new Map<string, Bullet[]>()
  for (const b of playbook.bullets) {
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
    return `[${t.timestamp}] tool=${t.tool} ${argsStr} outcome=${t.outcome?.slice(0, 200) ?? "unknown"}`
  }).join("\n")

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

    const pruneResult = pruneBullets(playbook.bullets, playbook.config.prune_threshold)
    playbook.bullets = pruneResult.kept
    pruned = pruneResult.pruned
  }

  playbook.stats.total_reflections++
  playbook.stats.total_bullets_added += added
  playbook.stats.total_bullets_merged += merged
  playbook.stats.total_bullets_pruned += pruned

  return { added, updated, merged, pruned }
}
