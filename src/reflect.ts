import type { ReflectionResult } from "./types.js"

export function extractResponseText(response: unknown): string {
  if (typeof response === "string") return response
  const r = response as { data?: unknown; error?: unknown }
  if (r.error !== undefined && r.error !== null) {
    throw new Error(`SDK error: ${JSON.stringify(r.error)}`)
  }
  try {
    const d = r.data as { parts?: Array<{ type: string; text?: string }> } | undefined
    if (d?.parts) {
      const textPart = d.parts.find((p) => p.type === "text" && p.text)
      if (textPart?.text) return textPart.text
    }
  } catch {}
  return JSON.stringify(response)
}

export function parseReflection(text: string): ReflectionResult | null {
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
