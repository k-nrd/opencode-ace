export interface Bullet {
  id: string;
  content: string;
  category: "strategy" | "pitfall" | "domain" | "tool_use" | "pattern";
  helpful_count: number;
  harmful_count: number;
  created_at: string;
  updated_at: string;
  source_session: string | null;
  tags: string[];
}

export interface Playbook {
  version: number;
  project: string;
  created_at: string;
  updated_at: string;
  bullets: Bullet[];
  stats: {
    total_sessions: number;
    total_reflections: number;
    total_bullets_added: number;
    total_bullets_pruned: number;
    total_bullets_merged: number;
  };
  config: PlaybookConfig;
}

export interface RenderOptions {
  tags?: Set<string>;
  minScore?: number;
  alwaysCategories?: string[];
}

export interface FeedbackEntry {
  bullet_id: string;
  rating: "helpful" | "harmful" | "neutral";
  strength: number;
  note?: string;
  timestamp: string;
  session_id: string | null;
}

export interface PlaybookConfig {
  max_bullets: number;
  dedup_threshold: number;
  prune_threshold: number;
  categories: string[];
  reflection_prompt: string | null;
  curation_prompt: string | null;
  auto_inject: boolean;
  max_inject_tokens: number;
  min_score_to_inject: number;
  max_reflection_rounds: number;
  min_traces_for_reflection: number;
  stale_bullet_ttl_days: number;
  inject_categories: string[];
  tag_matching: boolean;
}

export interface TraceEntry {
  timestamp: string;
  session_id: string | null;
  tool: string;
  args: Record<string, unknown>;
  outcome: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  is_retry: boolean;
  file_extension: string | null;
  error_signal: boolean;
}

export interface ReflectionResult {
  new_bullets: Omit<
    Bullet,
    | "id"
    | "helpful_count"
    | "harmful_count"
    | "created_at"
    | "updated_at"
    | "source_session"
  >[];
  updated_bullet_ids: {
    id: string;
    delta_helpful: number;
    delta_harmful: number;
  }[];
  reasoning: string;
}
