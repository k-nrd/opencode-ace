export interface Bullet {
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

export interface Playbook {
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

export interface PlaybookConfig {
  max_bullets: number
  dedup_threshold: number
  prune_threshold: number
  categories: string[]
  reflection_prompt: string | null
  curation_prompt: string | null
  auto_inject: boolean
  max_inject_tokens: number
}

export interface TraceEntry {
  timestamp: string
  session_id: string | null
  tool: string
  args: Record<string, unknown>
  outcome: string | null
  duration_ms: number | null
}

export interface ReflectionResult {
  new_bullets: Omit<Bullet, "id" | "helpful_count" | "harmful_count" | "created_at" | "updated_at" | "source_session">[]
  updated_bullet_ids: { id: string; delta_helpful: number; delta_harmful: number }[]
  reasoning: string
}
