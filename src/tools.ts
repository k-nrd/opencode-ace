import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"
import type { Playbook } from "./types.js"
import {
  aceDir, ensureDir, generateId, loadPlaybook, savePlaybook,
  pruneBullets, deduplicateBullets,
  TRACES_DIR, REFLECTIONS_DIR, DEFAULT_CONFIG,
} from "./playbook.js"

export function createTools() {
  const tools = {
    ace_init: tool({
      description:
        "Initialize an ACE playbook for this project. **Always check first** by looking for `.opencode/ace/playbook.json` or using ace_status. " +
        "If ACE is already initialized, this tool will return early with a message indicating the playbook already exists. " +
        "Creates the .opencode/ace/ directory with a playbook.json that will accumulate strategies, pitfalls, and domain knowledge " +
        "automatically as you work. The playbook improves itself through a Reflector→Curator loop that runs after each session.",
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

        const config = {
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

    ace_feedback: tool({
      description: "Provide feedback on a playbook bullet. Use this when you notice a bullet was helpful or harmful during your work.",
      args: {
        bullet_id: tool.schema.string().describe("The ID of the bullet to rate"),
        rating: tool.schema.enum(["helpful", "harmful", "neutral"]).describe(
          "Was this bullet helpful, harmful, or neutral for the current task?"
        ),
        strength: tool.schema.number().min(1).max(3).optional().describe(
          "Signal strength: 1=weak, 2=strong, 3=very strong. Defaults to 1. " +
          "Use 3 for explicit, unambiguous reactions like 'perfect' or 'undo that'. " +
          "Use 2 for clear reactions like 'thanks' or 'wrong'. Use 1 for subtle or inferred signals."
        ),
        note: tool.schema.string().optional().describe("Optional explanation of why this rating was given"),
      },
      async execute(args, context) {
        const playbook = loadPlaybook(context.directory)
        if (!playbook) return "No ACE playbook found. Use ace_init first."

        const bullet = playbook.bullets.find(b => b.id === args.bullet_id)
        if (!bullet) return `Bullet ${args.bullet_id} not found.`

        const delta = args.strength ?? 1
        if (args.rating === "helpful") {
          bullet.helpful_count += delta
        } else if (args.rating === "harmful") {
          bullet.harmful_count += delta
        }
        bullet.updated_at = new Date().toISOString()
        savePlaybook(context.directory, playbook)

        return `Bullet ${args.bullet_id} (${bullet.content.slice(0, 60)}...) rated ${args.rating} (strength ${delta}). Score: +${bullet.helpful_count}/-${bullet.harmful_count}`
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
  }

  return tools
}
