import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { callTool, toolCatalog, toolFailureMessage, ToolError, type ToolContext, type ToolSpec } from "./tools.ts";

/**
 * Loopback JSON-RPC for the local club tools. Not exported from the core
 * package entry, so the desktop bundle does not import Node's HTTP stack.
 * Decrypted text is returned only on this socket.
 */

const MAX_BODY = 1_048_576;

export async function startToolServer(options: {
  readonly host?: string;
  readonly port?: number;
  readonly context: ToolContext;
}): Promise<{ readonly host: string; readonly port: number; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new ToolError("forbidden");
  const server = createServer((request, response) => {
    void handle(request, response, options.context);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    throw new ToolError("forbidden");
  }
  let closed = false;
  return {
    host: address.address,
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, context: ToolContext): Promise<void> {
  try {
    if (request.method !== "POST") {
      send(response, 405, rpcError(null, -32600, "The request is not allowed."));
      return;
    }
    const parsed = JSON.parse(await readBody(request)) as unknown;
    const message = asRecord(parsed);
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    const method = message.method;
    if (method === "initialize") {
      send(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "shakespeare" },
          capabilities: { tools: {} },
        },
      });
      return;
    }
    if (method === "tools/list") {
      send(response, 200, { jsonrpc: "2.0", id, result: { tools: TOOLS_FOR_LIST } });
      return;
    }
    if (method === "tools/call") {
      const params = asRecord(message.params);
      const name = params.name;
      if (typeof name !== "string") throw new ToolError("rejected");
      const value = await callTool(context, name, params.arguments ?? {});
      send(response, 200, { jsonrpc: "2.0", id, result: value });
      return;
    }
    send(response, 200, rpcError(id, -32601, "The request is not allowed."));
  } catch (error) {
    send(response, 200, rpcError(null, -32000, toolFailureMessage(error)));
  }
}

const TOOLS_FOR_LIST = toolCatalog().map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: schema(tool),
}));

function schema(tool: ToolSpec): { readonly type: "object"; readonly properties: Record<string, { readonly type: string }>; readonly additionalProperties: false } {
  const properties: Record<string, { readonly type: string }> = {};
  for (const key of tool.inputKeys) {
    properties[key] = { type: key === "terms" || key === "paths" ? "array" : "string" };
  }
  return { type: "object", properties, additionalProperties: false };
}

function rpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new ToolError("rejected");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const raw = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
  });
  response.end(raw);
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ToolError("rejected");
  return input as Record<string, unknown>;
}
