import type { Json } from "../../../spec/contracts/runtime.js";
/** Bounded human-readable previews; never forward image/base64 blobs or credential fields. */
export function tracePreview(value: unknown): Json {
  let budget = 32768;
  function visit(v: any, depth: number): Json {
    if (budget <= 0 || depth > 8) return "[预览已截断]";
    if (v == null) return null;
    if (typeof v === "string") {
      const text = v.slice(0, budget);
      budget -= text.length;
      return text.length < v.length ? text + "\n[预览已截断]" : text;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (Array.isArray(v))
      return v.slice(0, 100).map((x) => visit(x, depth + 1));
    if (typeof v === "object") {
      if (v.type === "image" || v.type === "image_url")
        return { type: "image", preview: "[图片]" };
      return Object.fromEntries(
        Object.entries(v)
          .slice(0, 100)
          .map(([k, x]) => [
            k,
            /token|secret|credential|authorization|api.?key|base64/i.test(k)
              ? "[redacted]"
              : visit(x, depth + 1),
          ]),
      );
    }
    return String(v);
  }
  return visit(value, 0);
}
export function codexToolInput(item: Record<string, any>) {
  return tracePreview(
    Object.fromEntries(
      [
        "command",
        "cwd",
        "commandActions",
        "changes",
        "server",
        "tool",
        "arguments",
        "query",
        "action",
        "url",
        "prompt",
        "receiverThreadIds",
      ]
        .filter((k) => item[k] !== undefined)
        .map((k) => [k, item[k]]),
    ),
  );
}
export function codexToolResult(item: Record<string, any>) {
  return tracePreview(
    Object.fromEntries(
      [
        "type",
        "status",
        "aggregatedOutput",
        "exitCode",
        "durationMs",
        "result",
        "error",
        "content",
        "changes",
        "success",
      ]
        .filter((k) => item[k] !== undefined)
        .map((k) => [k, item[k]]),
    ),
  );
}
