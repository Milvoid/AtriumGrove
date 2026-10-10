import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { invariant } from "../../domain/src/index.js";
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("uint", {
  type: "number",
  validate: (value: number) => Number.isInteger(value) && value >= 0,
});
const schemas = Object.fromEntries(
  [
    ["thread/start", "ThreadStartParams"],
    ["thread/resume", "ThreadResumeParams"],
    ["turn/start", "TurnStartParams"],
    ["turn/steer", "TurnSteerParams"],
  ].map(([method, name]) => [
    method,
    ajv.compile(
      JSON.parse(
        readFileSync(
          new URL(`../fixtures/0.157.1/${name}.json`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  ]),
);
export function validateNativeRequest(method: string, params: unknown) {
  const validator = schemas[method];
  if (validator)
    invariant(
      validator(params),
      "NATIVE_SCHEMA_MISMATCH",
      ajv.errorsText(validator.errors),
    );
}
