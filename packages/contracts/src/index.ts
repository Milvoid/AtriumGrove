import { hostFrameSchema, runtimeEventSchema } from "./host-wire.js";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { DomainError } from "../../domain/src/index.js";
export type * from "./domain.js";
export type * from "../../../spec/contracts/runtime.js";
export const domainSchema = JSON.parse(
  readFileSync(
    new URL("../../../spec/contracts/domain.schema.json", import.meta.url),
    "utf8",
  ),
);
export const toolSchema = JSON.parse(
  readFileSync(
    new URL("../../../spec/contracts/tools.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
const addFormats = addFormatsModule as unknown as (a: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema(domainSchema);
const cache = new Map<string, ReturnType<Ajv2020["compile"]>>();
export function validate(name: string, value: unknown, tool = false) {
  const key = `${tool}:${name}`;
  let validator = cache.get(key);
  if (!validator) {
    validator = ajv.compile(
      tool
        ? toolSchema.$defs[name]
        : { $ref: domainSchema.$id + "#/$defs/" + name },
    );
    cache.set(key, validator);
  }
  if (!validator(value))
    throw new DomainError(
      "INVALID_REQUEST",
      ajv.errorsText(validator.errors),
      400,
    );
}
export const toolCapability: Record<string, string> = {
  collab_context: "collab.read",
  collab_read: "collab.read",
  collab_inbox: "collab.read",
  collab_ack: "collab.read",
  collab_post: "collab.post",
  task_list: "task.read",
  task_get: "task.read",
  task_create: "task.create",
  task_claim: "task.claim",
  task_transition: "task.transition",
  artifact_read: "artifact.read",
  artifact_register: "artifact.register",
  memory_propose: "memory.propose",
};
export type HostFrame = {
  schemaVersion: 1;
  type: string;
  [key: string]: unknown;
};
const frameValidator = ajv.compile(hostFrameSchema);
const eventValidator = ajv.compile(runtimeEventSchema);
export function validateFrame(value: unknown): asserts value is HostFrame {
  if (!frameValidator(value))
    throw new DomainError(
      "BAD_FRAME",
      ajv.errorsText(frameValidator.errors),
      400,
    );
}
export function validateEvent(value: unknown) {
  if (!eventValidator(value))
    throw new DomainError(
      "BAD_EVENT",
      ajv.errorsText(eventValidator.errors),
      400,
    );
}
export function validateJson(schema: object, value: unknown) {
  let validator;
  try {
    validator = ajv.compile(schema);
  } catch {
    throw new DomainError(
      "UNSUPPORTED_SCHEMA",
      "Approval schema is not supported",
      422,
    );
  }
  if (!validator(value))
    throw new DomainError(
      "INVALID_DECISION",
      ajv.errorsText(validator.errors),
      400,
    );
}
