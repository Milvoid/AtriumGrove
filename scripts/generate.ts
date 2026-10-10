import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const schema = JSON.parse(
  readFileSync("spec/contracts/domain.schema.json", "utf8"),
);
function type(s: any): string {
  if (s.$ref) return s.$ref.split("/").at(-1);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map(JSON.stringify).join(" | ");
  if (s.oneOf || s.anyOf) return (s.oneOf || s.anyOf).map(type).join(" | ");
  if (s.type === "object")
    return (
      "{ " +
      Object.entries(s.properties ?? {})
        .map(
          ([k, v]) =>
            `${JSON.stringify(k)}${s.required?.includes(k) ? "" : "?"}: ${type(v)};`,
        )
        .join(" ") +
      " " +
      (s.additionalProperties === true ? "[key: string]: unknown;" : "") +
      " }"
    );
  if (s.type === "array") return `Array<${type(s.items)}>`;
  return (
    (
      {
        integer: "number",
        number: "number",
        string: "string",
        boolean: "boolean",
        null: "null",
      } as Record<string, string>
    )[s.type] ?? "unknown"
  );
}
mkdirSync("packages/contracts/src", { recursive: true });
writeFileSync(
  "packages/contracts/src/domain.ts",
  "// Generated from spec/contracts/domain.schema.json. Do not edit.\n" +
    Object.entries(schema.$defs)
      .map(([k, v]) => `export type ${k} = ${type(v)};`)
      .join("\n") +
    "\n",
);
