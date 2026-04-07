import { type Plugin } from "@opencode-ai/plugin"
import * as path from "path"
import * as fs from "fs"
import type { TraceEntry } from "./types.js"
import {
  aceDir, generateId, loadPlaybook, savePlaybook,
  appendTrace, loadRecentTraces, renderPlaybook, buildReflectionPrompt, applyReflection,
  REFLECTIONS_DIR,
} from "./playbook.js"
import { extractResponseText, parseReflection } from "./reflect.js"
import { createTools } from "./tools.js"

export const ACEPlugin: Plugin = async ({ client, directory, $ }) => {
  let sessionTraces: TraceEntry[] = []
  let currentSessionId: string | null = null

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

      if (event.type === "session.idle") {
        const playbook = loadPlaybook(directory)
        if (!playbook || sessionTraces.length === 0) return

        const traces = loadRecentTraces(directory, 50)
        if (traces.length === 0) return

        const prompt = buildReflectionPrompt(traces, playbook, playbook.config.reflection_prompt)

        try {
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
          if (!reflection) return

          const result = applyReflection(playbook, reflection, currentSessionId)
          savePlaybook(directory, playbook)

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

    "experimental.chat.system.transform": async (_input, output) => {
      const playbook = loadPlaybook(directory)
      if (!playbook || !playbook.config.auto_inject || playbook.bullets.length === 0) return

      let rendered = renderPlaybook(playbook)
      if (!rendered) return

      if (rendered.length / 4 > playbook.config.max_inject_tokens) {
        const sorted = [...playbook.bullets]
          .sort((a, b) => (b.helpful_count - b.harmful_count) - (a.helpful_count - a.harmful_count))
        const truncated = { ...playbook, bullets: sorted.slice(0, 50) }
        rendered = renderPlaybook(truncated)
      }

      output.system.push(rendered)
    },

    "experimental.session.compacting": async (_input, output) => {
      const playbook = loadPlaybook(directory)
      if (!playbook || !playbook.config.auto_inject || playbook.bullets.length === 0) return

      let rendered = renderPlaybook(playbook)
      if (!rendered) return

      if (rendered.length / 4 > playbook.config.max_inject_tokens) {
        const sorted = [...playbook.bullets]
          .sort((a, b) => (b.helpful_count - b.harmful_count) - (a.helpful_count - a.harmful_count))
        const truncated = { ...playbook, bullets: sorted.slice(0, 50) }
        rendered = renderPlaybook(truncated)
      }

      output.context.push(rendered)
    },
  }
}

export default ACEPlugin
