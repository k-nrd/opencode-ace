import { tool } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"
import type { Bullet, Playbook, TraceEntry } from "./types.js"
import type { OpencodeClient } from "@opencode-ai/sdk"
import {
  aceDir, ensureDir, generateId, loadPlaybook, savePlaybook,
  loadRecentTraces, renderPlaybook, buildReflectionPrompt, applyReflection,
  pruneBullets, deduplicateBullets,
  TRACES_DIR, REFLECTIONS_DIR, DEFAULT_CONFIG,
} from "./playbook.js"
import { extractResponseText, parseReflection } from "./reflect.js"

export interface ToolDeps {
  client: OpencodeClient
  directory: string
  getSessionId: () => string | null
}

export function createTools(deps: ToolDeps) {
  const { client, directory, getSessionId } = deps

  return {

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

        const traces = loadRecentTraces(context.directory, args.max_traces ?? 50)
        if (traces.length === 0) return "No traces to reflect on yet. Work on some tasks first."

        const prompt = buildReflectionPrompt(traces, playbook, playbook.config.reflection_prompt)

        try {
          const reflectSession = await client.session.create({
            body: { title: "ACE Reflection" },
          })
          const sessionId = reflectSession.data!.id

          let responseText: string
          try {
            const response = await client.session.prompt({
              path: { id: sessionId },
              body: {
                system: "You are the Reflector in an ACE (Agentic Context Engineering) loop. Respond with ONLY a JSON object, no markdown fences.",
                parts: [{ type: "text", text: prompt }],
              },
            })
            responseText = extractResponseText(response)
          } finally {
            await client.session.delete({ path: { id: sessionId } }).catch(() => {})
          }

          const reflection = parseReflection(responseText)
          if (!reflection) {
            return "Reflection produced unparseable output. Saving raw response for debugging.\n\n" + responseText.slice(0, 500)
          }

          const result = applyReflection(playbook, reflection, context.sessionID)
          savePlaybook(context.directory, playbook)

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
  }
}
