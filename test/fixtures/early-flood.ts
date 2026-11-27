import { parentPort } from "node:worker_threads";

for (let count = 0; count < 2; count++) parentPort!.postMessage({ kind: "early", message: "x".repeat(600 * 1024) });
export {};
