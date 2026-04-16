import { describe, test, expect } from "bun:test";
import {
  estimateTokens,
  extractFileExtension,
  detectErrorSignal,
  pruneBullets,
  renderPlaybook,
} from "../src/playbook.js";
import type { Bullet, Playbook } from "../src/types.js";

describe("estimateTokens", () => {
  test("returns higher token count for symbol-heavy text", () => {
    const code = 'const x = foo["bar"] ?? baz?.qux();';
    const prose = "This is a sentence about programming concepts.";
    expect(estimateTokens(code)).toBeGreaterThan(estimateTokens(prose) * 0.8);
  });

  test("returns non-zero for any non-empty string", () => {
    expect(estimateTokens("hello")).toBeGreaterThan(0);
  });

  test("returns 1 for single char", () => {
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("extractFileExtension", () => {
  test("extracts ts from filePath", () => {
    expect(extractFileExtension({ filePath: "src/index.ts" })).toBe("ts");
  });

  test("extracts py from path", () => {
    expect(extractFileExtension({ path: "app/main.py" })).toBe("py");
  });

  test("extracts rs from file", () => {
    expect(extractFileExtension({ file: "lib.rs" })).toBe("rs");
  });

  test("returns null for no file arg", () => {
    expect(extractFileExtension({})).toBeNull();
  });

  test("returns null when no dot in path", () => {
    expect(extractFileExtension({ filePath: "src/components" })).toBeNull();
  });

  test("handles nested paths", () => {
    expect(
      extractFileExtension({ filePath: "packages/core/src/utils/helpers.ts" }),
    ).toBe("ts");
  });

  test("lowercases extension", () => {
    expect(extractFileExtension({ filePath: "app/Main.JS" })).toBe("js");
  });

  test("rejects very long extensions", () => {
    expect(
      extractFileExtension({ filePath: "file." + "a".repeat(20) }),
    ).toBeNull();
  });
});

describe("detectErrorSignal", () => {
  test("detects 'error' in outcome", () => {
    expect(detectErrorSignal("TypeError: cannot read property")).toBe(true);
  });

  test("detects 'fail' in outcome", () => {
    expect(detectErrorSignal("Build failed: missing module")).toBe(true);
  });

  test("detects 'exception' in outcome", () => {
    expect(detectErrorSignal("Exception in thread main")).toBe(true);
  });

  test("detects 'traceback' in outcome", () => {
    expect(detectErrorSignal("Traceback (most recent call last):")).toBe(true);
  });

  test("detects 'fatal' in outcome", () => {
    expect(detectErrorSignal("FATAL: out of memory")).toBe(true);
  });

  test("detects 'denied' in outcome", () => {
    expect(detectErrorSignal("Permission denied")).toBe(true);
  });

  test("detects 'not found' in outcome", () => {
    expect(detectErrorSignal("File not found")).toBe(true);
  });

  test("detects 'cannot' in outcome", () => {
    expect(detectErrorSignal("Cannot read property")).toBe(true);
  });

  test("detects 'unable to' in outcome", () => {
    expect(detectErrorSignal("Unable to connect to host")).toBe(true);
  });

  test("returns false for success outcome", () => {
    expect(detectErrorSignal("3 tests passed")).toBe(false);
  });

  test("returns false for null outcome", () => {
    expect(detectErrorSignal(null)).toBe(false);
  });

  test("is case insensitive", () => {
    expect(detectErrorSignal("ERROR: something went wrong")).toBe(true);
    expect(detectErrorSignal("ERROR")).toBe(true);
  });
});

describe("pruneBullets with stale TTL", () => {
  const now = new Date();

  function makeBullet(
    daysAgo: number,
    helpful: number,
    harmful: number,
  ): Bullet {
    return {
      id: "test",
      content: "test bullet",
      category: "strategy",
      helpful_count: helpful,
      harmful_count: harmful,
      created_at: new Date(
        now.getTime() - daysAgo * 24 * 60 * 60 * 1000,
      ).toISOString(),
      updated_at: now.toISOString(),
      source_session: null,
      tags: [],
    };
  }

  test("keeps recent untested bullets", () => {
    const bullets = [makeBullet(1, 0, 0)];
    const result = pruneBullets(bullets, -2, 14);
    expect(result.kept).toHaveLength(1);
    expect(result.pruned).toBe(0);
  });

  test("prunes stale untested bullets", () => {
    const bullets = [makeBullet(20, 0, 0)];
    const result = pruneBullets(bullets, -2, 14);
    expect(result.kept).toHaveLength(0);
    expect(result.pruned).toBe(1);
  });

  test("keeps scored bullets even if old", () => {
    const bullets = [makeBullet(30, 3, 0)];
    const result = pruneBullets(bullets, -2, 14);
    expect(result.kept).toHaveLength(1);
  });

  test("prunes negative-score bullets", () => {
    const bullets = [makeBullet(0, 0, 5)];
    const result = pruneBullets(bullets, -2, 14);
    expect(result.kept).toHaveLength(0);
  });

  test("keeps bullets at boundary age", () => {
    const bullets = [makeBullet(13, 0, 0)];
    const result = pruneBullets(bullets, -2, 14);
    expect(result.kept).toHaveLength(1);
  });

  test("prunes bullets beyond boundary age", () => {
    const bullets = [makeBullet(15, 0, 0)];
    const result = pruneBullets(bullets, -2, 14);
    expect(result.kept).toHaveLength(0);
  });

  test("uses default 14 days when staleDays not passed", () => {
    const bullets = [makeBullet(20, 0, 0)];
    const result = pruneBullets(bullets, -2);
    expect(result.kept).toHaveLength(0);
  });
});

describe("renderPlaybook with filters", () => {
  const basePlaybook: Playbook = {
    version: 1,
    project: "test",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    bullets: [
      {
        id: "a1",
        content: "Use cargo check for Rust",
        category: "strategy",
        helpful_count: 5,
        harmful_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_session: null,
        tags: ["rust", "testing"],
      },
      {
        id: "b2",
        content: "Always check nulls",
        category: "pitfall",
        helpful_count: 2,
        harmful_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_session: null,
        tags: [],
      },
      {
        id: "c3",
        content: "Python uses virtualenv",
        category: "domain",
        helpful_count: 3,
        harmful_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_session: null,
        tags: ["python"],
      },
      {
        id: "d4",
        content: "Bad advice",
        category: "strategy",
        helpful_count: 0,
        harmful_count: 5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_session: null,
        tags: ["rust"],
      },
      {
        id: "e5",
        content: "Use tsconfig paths",
        category: "tool_use",
        helpful_count: 1,
        harmful_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_session: null,
        tags: ["typescript"],
      },
    ],
    stats: {
      total_sessions: 0,
      total_reflections: 0,
      total_bullets_added: 0,
      total_bullets_pruned: 0,
      total_bullets_merged: 0,
    },
    config: {
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
    },
  };

  test("with no options, renders all bullets", () => {
    const rendered = renderPlaybook(basePlaybook);
    expect(rendered).toContain("Use cargo check for Rust");
    expect(rendered).toContain("Always check nulls");
    expect(rendered).toContain("Python uses virtualenv");
    expect(rendered).toContain("Bad advice");
    expect(rendered).toContain("Use tsconfig paths");
  });

  test("with minScore=1, excludes negative-score bullets", () => {
    const rendered = renderPlaybook(basePlaybook, { minScore: 1 });
    expect(rendered).toContain("Use cargo check for Rust");
    expect(rendered).toContain("Always check nulls");
    expect(rendered).toContain("Python uses virtualenv");
    expect(rendered).not.toContain("Bad advice");
    expect(rendered).toContain("Use tsconfig paths");
  });

  test("with tags=new Set(['rust']), includes matching bullets plus alwaysCategories", () => {
    const rendered = renderPlaybook(basePlaybook, {
      tags: new Set(["rust"]),
      minScore: 0,
      alwaysCategories: ["pitfall", "domain"],
    });
    expect(rendered).toContain("Use cargo check for Rust");
    expect(rendered).toContain("Always check nulls");
    expect(rendered).toContain("Python uses virtualenv");
    expect(rendered).not.toContain("Bad advice");
    expect(rendered).not.toContain("Use tsconfig paths");
  });

  test("pitfall and domain bullets included regardless of tags when in alwaysCategories", () => {
    const rendered = renderPlaybook(basePlaybook, {
      tags: new Set(["typescript"]),
      minScore: 0,
      alwaysCategories: ["pitfall", "domain"],
    });
    expect(rendered).toContain("Always check nulls");
    expect(rendered).toContain("Python uses virtualenv");
    expect(rendered).toContain("Use tsconfig paths");
  });

  test("bullets with no tags excluded when tags filtering is active", () => {
    const rendered = renderPlaybook(basePlaybook, {
      tags: new Set(["rust"]),
      minScore: 0,
      alwaysCategories: [],
    });
    expect(rendered).not.toContain("Always check nulls");
  });

  test("returns empty string when all bullets filtered out", () => {
    const rendered = renderPlaybook(basePlaybook, {
      tags: new Set(["haskell"]),
      minScore: 10,
      alwaysCategories: [],
    });
    expect(rendered).toBe("");
  });

  test("returns empty string for empty playbook", () => {
    const empty: Playbook = { ...basePlaybook, bullets: [] };
    const rendered = renderPlaybook(empty);
    expect(rendered).toBe("");
  });

  test("bullet order sorted by score within category", () => {
    const bullets = [
      {
        id: "low",
        content: "low score",
        category: "strategy",
        helpful_count: 1,
        harmful_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_session: null,
        tags: ["ts"],
      },
      {
        id: "high",
        content: "high score",
        category: "strategy",
        helpful_count: 10,
        harmful_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_session: null,
        tags: ["ts"],
      },
    ];
    const p = { ...basePlaybook, bullets };
    const rendered = renderPlaybook(p, {
      tags: new Set(["ts"]),
      minScore: 0,
      alwaysCategories: [],
    });
    const highIdx = rendered.indexOf("high score");
    const lowIdx = rendered.indexOf("low score");
    expect(highIdx).toBeLessThan(lowIdx);
  });
});
