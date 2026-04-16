import { describe, test, expect } from "bun:test";
import { extractResponseText, parseReflection } from "../src/reflect.js";

describe("extractResponseText", () => {
  test("passes through plain strings", () => {
    expect(extractResponseText("hello")).toBe("hello");
  });

  test("extracts text from SDK success response", () => {
    const response = {
      data: {
        info: { id: "msg_123" },
        parts: [
          {
            type: "text",
            text: '{"reasoning":"test","new_bullets":[],"updated_bullet_ids":[]}',
          },
        ],
      },
      error: undefined,
      request: {},
      response: {},
    };
    expect(extractResponseText(response)).toBe(
      '{"reasoning":"test","new_bullets":[],"updated_bullet_ids":[]}',
    );
  });

  test("throws on SDK error response (was silently producing empty reflection)", () => {
    const errorResponse = {
      error: {
        data: { sessionID: "default" },
        error: [
          {
            origin: "string",
            code: "invalid_format",
            message: 'must start with "ses"',
          },
        ],
        success: false,
      },
      request: {},
      response: {},
    };
    expect(() => extractResponseText(errorResponse)).toThrow(/SDK error/);
  });

  test("handles response with no text parts", () => {
    const response = {
      data: {
        parts: [{ type: "tool_call", text: "ignored" }, { type: "step_start" }],
      },
      error: undefined,
      request: {},
      response: {},
    };
    const result = extractResponseText(response);
    expect(result).toContain("tool_call");
  });

  test("handles empty response with no data or error", () => {
    const response = { error: undefined, request: {}, response: {} };
    const result = extractResponseText(response);
    expect(result).toBe('{"request":{},"response":{}}');
  });
});

describe("parseReflection", () => {
  test("parses clean JSON", () => {
    const result = parseReflection(
      '{"new_bullets":[],"updated_bullet_ids":[],"reasoning":"learned something"}',
    );
    expect(result).toEqual({
      new_bullets: [],
      updated_bullet_ids: [],
      reasoning: "learned something",
    });
  });

  test("strips markdown fences", () => {
    const result = parseReflection(
      '```json\n{"new_bullets":[],"updated_bullet_ids":[],"reasoning":"ok"}\n```',
    );
    expect(result).not.toBeNull();
    expect(result!.reasoning).toBe("ok");
  });

  test("returns null for unparseable text", () => {
    expect(parseReflection("not json at all")).toBeNull();
  });

  test("defaults missing fields", () => {
    const result = parseReflection("{}");
    expect(result).toEqual({
      new_bullets: [],
      updated_bullet_ids: [],
      reasoning: "",
    });
  });
});

describe("full pipeline: SDK response → reflection result", () => {
  test("success path produces populated reasoning", () => {
    const sdkResponse = {
      data: {
        parts: [
          {
            type: "text",
            text: '{"new_bullets":[{"content":"wrap calls in try/catch","category":"strategy","tags":["error-handling"]}],"updated_bullet_ids":[],"reasoning":"Traces show multiple unhandled subprocess errors."}',
          },
        ],
      },
      error: undefined,
      request: {},
      response: {},
    };
    const text = extractResponseText(sdkResponse);
    const reflection = parseReflection(text);
    expect(reflection).not.toBeNull();
    expect(reflection!.reasoning).toBe(
      "Traces show multiple unhandled subprocess errors.",
    );
    expect(reflection!.new_bullets).toHaveLength(1);
  });

  test("error response throws before reaching parseReflection", () => {
    const errorResponse = {
      error: {
        data: { sessionID: "default" },
        error: [{ code: "invalid_format", message: 'must start with "ses"' }],
        success: false,
      },
      request: {},
      response: {},
    };
    expect(() => extractResponseText(errorResponse)).toThrow(/SDK error/);
  });
});
