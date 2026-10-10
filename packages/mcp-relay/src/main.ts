import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const socketPath = process.env.HARBOR_SOCKET,
  token = process.env.HARBOR_RELAY_TOKEN;
if (!socketPath || !token)
  throw new Error("Missing launch-bound relay credentials");
const server = new Server(
  { name: process.env.HARBOR_RELAY_NAME ?? "harbor", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
async function request(name: string, args: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath!);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Host tool request timed out"));
    }, 600000);
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ id: randomUUID(), token, name, args }) + "\n",
      ),
    );
    socket.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    createInterface({ input: socket }).once("line", (line) => {
      clearTimeout(timeout);
      socket.end();
      try {
        const result = JSON.parse(line);
        result.error
          ? reject(new Error(result.error.message))
          : resolve(result.result);
      } catch (e) {
        reject(e);
      }
    });
  });
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: await request("tools/list", {}),
}));
server.setRequestHandler(CallToolRequestSchema, async (r) => {
  try {
    return await request(r.params.name, r.params.arguments ?? {});
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "TOOL_ERROR",
            message: String(e),
            retryable: false,
          }),
        },
      ],
    };
  }
});
await server.connect(new StdioServerTransport());
