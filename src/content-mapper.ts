#!/usr/bin/env node
import { compileTlaSource } from "./tla-source.js";

// TypeScript 7.1 content-mapper JSON-RPC transport. Only declarations are
// surfaced to the type checker; execution is handled by Vite or Node.
let buffer = Buffer.alloc(0);
function reply(id: unknown, result?: unknown, error?: string) {
  const body = Buffer.from(JSON.stringify(error === undefined ? { jsonrpc: "2.0", id, result } :
    { jsonrpc: "2.0", id, error: { code: -32603, message: error } }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const match = /^Content-Length:\s*(\d+)$/im.exec(buffer.subarray(0, headerEnd).toString());
    if (!match) { buffer = Buffer.alloc(0); break; }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) break;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()) as
      { id?: unknown; method?: string; params?: { content?: string } };
    buffer = buffer.subarray(headerEnd + 4 + length);
    if (message.id === undefined) continue;
    try {
      if (message.method === "initialize") reply(message.id, { protocolVersion: 1, positionEncoding: "utf-16", diagnosticSource: "chisel" });
      else if (message.method === "openProject") reply(message.id, {});
      else if (message.method === "closeProject") reply(message.id, null);
      else if (message.method === "transform") reply(message.id, { text: compileTlaSource(message.params?.content ?? "").declarations, extension: ".d.ts", mappings: [] });
      else reply(message.id, undefined, `Unknown content-mapper method: ${message.method}`);
    } catch (error) { reply(message.id, undefined, error instanceof Error ? error.message : String(error)); }
  }
});
