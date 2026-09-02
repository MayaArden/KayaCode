import { Type, type TSchema } from "typebox";

/**
 * Convert a JSON Schema (as MCP tools declare in inputSchema) to a TypeBox
 * schema for pi-agent-core's AgentTool parameters. Covers the common subset:
 * object/properties/required, string/number/integer/boolean/array, enums,
 * anyOf/oneOf unions, nested objects. Unknown shapes degrade to Type.Any() —
 * the MCP server's own validation still applies at call time.
 */
type Json = Record<string, unknown>;

export function jsonSchemaToTypeBox(schema: unknown): TSchema {
  if (!schema || typeof schema !== "object") return Type.Any();
  const s = schema as Json;

  if (Array.isArray(s.enum)) {
    return Type.Union((s.enum as unknown[]).map((v) => Type.Literal(v as string | number | boolean)));
  }
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const variants = s[unionKey];
    if (Array.isArray(variants) && variants.length > 0) {
      return Type.Union(variants.map((v) => jsonSchemaToTypeBox(v)));
    }
  }

  const description: Record<string, string> = typeof s.description === "string" ? { description: s.description } : {};

  switch (s.type) {
    case "object":
      return objectSchema(s, description);
    case "string":
      return Type.String(description);
    case "number":
      return Type.Number(description);
    case "integer":
      return Type.Integer(description);
    case "boolean":
      return Type.Boolean(description);
    case "array":
      return Type.Array(jsonSchemaToTypeBox(s.items), description);
    case "null":
      return Type.Null(description);
    default:
      // Schemaless but has properties? Treat as object. Otherwise any.
      if (s.properties && typeof s.properties === "object") return objectSchema(s, description);
      return Type.Any(description);
  }
}

function objectSchema(s: Json, extra: Record<string, string>): TSchema {
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const props: Record<string, TSchema> = {};
  const properties = (s.properties ?? {}) as Record<string, unknown>;
  for (const [key, propSchema] of Object.entries(properties)) {
    const converted = jsonSchemaToTypeBox(propSchema);
    props[key] = required.has(key) ? converted : Type.Optional(converted);
  }
  return Type.Object(props, extra);
}
