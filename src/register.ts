import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { compileTlaSource } from "./tla-source.js";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !new URL(url).pathname.endsWith(".tla")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: compileTlaSource(readFileSync(new URL(url), "utf8")).code };
  },
});
