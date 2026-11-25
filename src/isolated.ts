import { Worker } from "node:worker_threads";

export interface IsolatedResult {
  readonly exitCode: number;
  readonly logs: readonly { readonly stream: "stdout" | "stderr"; readonly message: string }[];
  readonly error?: string;
}
// What the run is doing, said on stderr once it has run `after` milliseconds
// (3 seconds by default) and from then on every `every` milliseconds (a
// minute), as Souther says which behavior a long measurement is on. The worker
// posts each phase as it enters it; the timing is kept here, on a thread the
// measurement does not block.
export interface ProgressOptions {
  readonly after?: number;
  readonly every?: number;
  readonly write?: (line: string) => void;
  // Where what the run says before its result is written as it says it (what
  // to change in the model before it is measured); without it, those lines
  // are put before the result's logs.
  readonly early?: (line: string) => void;
}
export async function runIsolated(argv: readonly string[], timeoutMs = 30000, progress: ProgressOptions = {}): Promise<IsolatedResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeout must be a positive safe integer");
  const entry = new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url).href;
  const worker = new Worker(`const { workerData } = require("node:worker_threads");
    import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));`, {
    eval: true, workerData: { chisel: true, entry, argv },
    resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true,
  });
  let bytes = 0;
  let phase: string | undefined;
  const early: string[] = [];
  let said: string | undefined;
  const write = progress.write ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const say = () => {
    if (phase !== undefined && phase !== said) {
      said = phase;
      write(`chisel: ${phase}`);
    }
  };
  let ticker: ReturnType<typeof setInterval> | undefined;
  const starter = setTimeout(() => {
    say();
    ticker = setInterval(() => { said = undefined; say(); }, progress.every ?? 60000);
  }, progress.after ?? 3000);
  const output: { stream: "stdout" | "stderr"; message: string }[] = [];
  return new Promise(resolve => {
    let done = false;
    const finish = async (result: IsolatedResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(starter);
      if (ticker !== undefined) clearInterval(ticker);
      await worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => void finish({ exitCode: 1, logs: output, error: `Execution exceeded ${timeoutMs} ms; the worker was terminated` }), timeoutMs);
    for (const stream of ["stdout", "stderr"] as const) worker[stream].on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 1024 * 1024) void finish({ exitCode: 1, logs: [], error: "Execution output exceeded 1 MiB" });
      else output.push({ stream, message: data.toString().trimEnd() });
    });
    worker.on("message", (message: IsolatedResult | { readonly kind: "progress" | "early"; readonly message: string }) => {
      if ("kind" in message && message.kind === "progress") {
        phase = message.message;
        return;
      }
      if ("kind" in message && message.kind === "early") {
        if (progress.early !== undefined) progress.early(message.message);
        else early.push(message.message);
        return;
      }
      const posted = message as IsolatedResult;
      const result = early.length === 0 ? posted : { ...posted, logs: [...early.map(line => ({ stream: "stdout" as const, message: line })), ...posted.logs] };
      const size = result.logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.message), 0);
      void finish(size > 1024 * 1024 ? { exitCode: 1, logs: [], error: "Execution output exceeded 1 MiB" } : result);
    });
    worker.once("error", error => void finish({ exitCode: 1, logs: output, error: error instanceof Error ? error.message : String(error) }));
    worker.once("exit", code => { if (!done) void finish({ exitCode: 1, logs: output, error: `Worker exited without a result (${code})` }); });
  });
}
