import { type Plugin } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"
import type { TraceEntry, Playbook } from "./types.js"
import {
  aceDir, generateId, loadPlaybook, savePlaybook,
  appendTrace, loadRecentTraces, renderPlaybook, buildReflectionPrompt, applyReflection,
  estimateTokens, extractFileExtension, detectErrorSignal, cleanupOldTraces, applyImplicitFeedback,
  renderGeneratorInstructions,
  REFLECTIONS_DIR,
} from "./playbook.js"
import { extractResponseText, parseReflection } from "./reflect.js"
import { createTools } from "./tools.js"

export const ACEPlugin: Plugin = async ({ client, directory, $ }) => {
  let sessionTraces: TraceEntry[] = []
  let currentSessionId: string | null = null
  let sessionTags: Set<string> = new Set()
  let previousToolCall: { tool: string; timestamp: string } | null = null

  function detectSessionTags(tool: string, args: Record<string, unknown>): void {
    const ext = extractFileExtension(args)
    if (ext && !["json", "md", "txt", "lock", "log"].includes(ext)) {
      sessionTags.add(ext)
    }
    const filePath = (args.filePath ?? args.path ?? args.file ?? "") as string
    if (typeof filePath === "string") {
      const parts = filePath.split("/")
      for (const part of parts) {
        if (part === "src" || part === "test" || part === "tests" || part === "docs" || part === "config") {
          sessionTags.add(part)
        }
      }
    }
    if (tool === "bash") {
      const cmd = (args.command ?? "") as string
      if (typeof cmd === "string") {
        if (/\bcargo\b/.test(cmd)) sessionTags.add("rust")
        if (/\b(python|pip|pytest|mypy|ruff)\b/.test(cmd)) sessionTags.add("python")
        if (/\b(tsc|tsx|tsx|npm|pnpm|yarn|bun)\b/.test(cmd)) sessionTags.add("typescript")
        if (/\b(go test|go run|go build)\b/.test(cmd)) sessionTags.add("go")
        if (/\b(ruby|bundle|rake|rspec)\b/.test(cmd)) sessionTags.add("ruby")
        if (/\b(gradle|mvn|java)\b/.test(cmd)) sessionTags.add("java")
        if (/\b(dotnet|msbuild)\b/.test(cmd)) sessionTags.add("dotnet")
      }
    }
  }

  function renderForInjection(playbook: Playbook): string {
    const config = playbook.config
    const minScore = config.min_score_to_inject ?? 0
    const alwaysCategories = config.inject_categories ?? ["pitfall", "domain"]
    const useTags = config.tag_matching !== false && sessionTags.size > 0

    let rendered: string
    if (useTags) {
      rendered = renderPlaybook(playbook, {
        tags: sessionTags,
        minScore,
        alwaysCategories,
      })
    } else {
      rendered = renderPlaybook(playbook, { minScore })
    }

    if (!rendered) return ""

    const maxTokens = config.max_inject_tokens ?? 4000
    if (estimateTokens(rendered) > maxTokens) {
      const sorted = [...playbook.bullets]
        .filter(b => (b.helpful_count - b.harmful_count) >= minScore)
        .sort((a, b) => (b.helpful_count - b.harmful_count) - (a.helpful_count - a.harmful_count))
      const truncated = { ...playbook, bullets: sorted.slice(0, 30) }
      if (useTags) {
        rendered = renderPlaybook(truncated, {
          tags: sessionTags,
          minScore,
          alwaysCategories,
        })
      } else {
        rendered = renderPlaybook(truncated, { minScore })
      }
    }

    return rendered
  }

  return {

    tool: createTools({
      client,
      directory,
      getSessionId: () => currentSessionId,
    }),

    config: async (input) => {
      input.command = input.command ?? {}
      input.command["ace-init"] = {
        template: "Run the ace_init tool to initialize an ACE playbook. $ARGUMENTS",
        description: "Initialize ACE playbook",
      }
      input.command["ace-reset"] = {
        template: 'Run the ace_reset tool with mode "$1". Default to soft if not specified.',
        description: "Reset ACE playbook (soft/hard)",
      }
      input.command["ace-feedback"] = {
        template: 'Run the ace_feedback tool with bullet_id "$1" and rating "$2". $ARGUMENTS',
        description: "Rate a playbook bullet as helpful/harmful",
      }
    },

    "tool.execute.after": async (input, output) => {
      const playbook = loadPlaybook(directory)
      if (!playbook) return

      detectSessionTags(input.tool, input.args ?? {})

      const outcome = typeof output.output === "string" ? output.output.slice(0, 500) : null
      const isRetry = previousToolCall != null
        && previousToolCall.tool === input.tool
        && (Date.now() - new Date(previousToolCall.timestamp).getTime()) < 30000

      const entry: TraceEntry = {
        timestamp: new Date().toISOString(),
        session_id: currentSessionId,
        tool: input.tool,
        args: input.args ?? {},
        outcome,
        duration_ms: null,
        exit_code: null,
        is_retry: isRetry,
        file_extension: extractFileExtension(input.args ?? {}),
        error_signal: detectErrorSignal(outcome),
      }

      previousToolCall = { tool: input.tool, timestamp: entry.timestamp }

      applyImplicitFeedback(playbook, entry, previousToolCall, directory)

      sessionTraces.push(entry)
      appendTrace(directory, entry)
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        currentSessionId = (event as any).properties?.id ?? generateId()
        sessionTraces = []
        sessionTags = new Set()
        previousToolCall = null
        const playbook = loadPlaybook(directory)
        if (playbook) {
          playbook.stats.total_sessions++
          savePlaybook(directory, playbook)
        }
      }

      if (event.type === "session.idle") {
        const playbook = loadPlaybook(directory)
        if (!playbook) return

        const minTraces = playbook.config.min_traces_for_reflection ?? 5
        if (sessionTraces.length < minTraces) return

        const traces = loadRecentTraces(directory, 50)
        if (traces.length === 0) return

        const maxRounds = playbook.config.max_reflection_rounds ?? 3
        let totalAdded = 0
        let totalPruned = 0

        try {
          for (let round = 0; round < maxRounds; round++) {
            const prompt = buildReflectionPrompt(traces, playbook, playbook.config.reflection_prompt, round)

            const reflectSession = await client.session.create({
              body: { title: "ACE Reflection" },
            })
            const reflectSessionId = reflectSession.data!.id

            let responseText: string
            try {
              const response = await client.session.prompt({
                path: { id: reflectSessionId },
                body: {
                  system: "You are the Reflector in an ACE (Agentic Context Engineering) loop. Respond with ONLY a JSON object, no markdown fences.",
                  parts: [{ type: "text", text: prompt }],
                },
              })
              responseText = extractResponseText(response)
            } finally {
              await client.session.delete({ path: { id: reflectSessionId } }).catch(() => {})
            }

            const reflection = parseReflection(responseText)
            if (!reflection) break

            const result = applyReflection(playbook, reflection, currentSessionId)
            totalAdded += result.added
            totalPruned += result.pruned

            if (round === 0) {
              savePlaybook(directory, playbook)
            }

            if (result.added === 0 && result.updated === 0) break
          }

          savePlaybook(directory, playbook)

          cleanupOldTraces(directory, 30)

          const reflPath = path.join(
            aceDir(directory), REFLECTIONS_DIR,
            `${new Date().toISOString().replace(/[:.]/g, "-")}.json`
          )
          fs.writeFileSync(reflPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            session_id: currentSessionId,
            traces_analyzed: traces.length,
            rounds_completed: maxRounds,
            total_added: totalAdded,
            total_pruned: totalPruned,
          }, null, 2))

          await client.app.log({
            body: {
              service: "opencode-ace",
              level: "info",
              message: `Reflection complete (${maxRounds} rounds): +${totalAdded} bullets, ${totalPruned} pruned`,
            },
          })
        } catch {
          savePlaybook(directory, playbook)
        }

        sessionTraces = []
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const playbook = loadPlaybook(directory)
      if (!playbook || !playbook.config.auto_inject) return

      const playbookRendered = renderForInjection(playbook)
      const instructions = renderGeneratorInstructions()

      if (playbookRendered) output.system.push(playbookRendered)
      if (instructions) output.system.push(instructions)
    },

    "experimental.session.compacting": async (_input, output) => {
      const playbook = loadPlaybook(directory)
      if (!playbook || !playbook.config.auto_inject) return

      const playbookRendered = renderForInjection(playbook)
      const instructions = renderGeneratorInstructions()

      if (playbookRendered) output.context.push(playbookRendered)
      if (instructions) output.context.push(instructions)
    },
  }
}

export default ACEPlugin
