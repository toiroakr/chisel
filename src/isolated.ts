import { Worker } from "node:worker_threads";

export interface IsolatedResult {
  readonly exitCode: number;
  readonly logs: readonly { readonly stream: "stdout" | "stderr"; readonly message: string }[];
  readonly error?: string;
}
export async function runIsolated(argv: readonly string[], timeoutMs = 30000): Promise<IsolatedResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeout must be a positive safe integer");
  const entry = new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url).href;
  const worker = new Worker(`const { workerData } = require("node:worker_threads");
    import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`, {
    eval: true, workerData: { chisel: true, entry, argv },
    resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true,
  });
  let bytes = 0;
  const output: { stream: "stdout" | "stderr"; message: string }[] = [];
  return new Promise(resolve => {
    let done = false;
    const finish = async (result: IsolatedResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      await worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => void finish({ exitCode: 1, logs: output, error: `Execution exceeded ${timeoutMs} ms; the worker was terminated` }), timeoutMs);
    for (const stream of ["stdout", "stderr"] as const) worker[stream].on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 1024 * 1024) void finish({ exitCode: 1, logs: [], error: "Execution output exceeded 1 MiB" });
      else output.push({ stream, message: data.toString().trimEnd() });
    });
    worker.once("message", (result: IsolatedResult) => {
      const size = result.logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.message), 0);
      void finish(size > 1024 * 1024 ? { exitCode: 1, logs: [], error: "Execution output exceeded 1 MiB" } : result);
    });
    worker.once("error", error => void finish({ exitCode: 1, logs: output, error: error instanceof Error ? error.message : String(error) }));
    worker.once("exit", code => { if (!done) void finish({ exitCode: 1, logs: output, error: `Worker exited without a result (${code})` }); });
  });
}
