import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compileTlaSource, checkTlaSource, mapTlaSource } from "../src/tla-source.js";
import { createTlaMachine, tlaEqual, tlaExcept, tlaInRange } from "../src/tla-runtime.js";
import { chiselTla } from "../src/vite.js";

const source = await readFile(new URL("../examples/counter.tla", import.meta.url), "utf8");

function execute(sourceText: string) {
  const generated = compileTlaSource(sourceText).code
    .replace(/^import .*\n/, "").replace("export const machine", "const machine").replace("export default machine;", "return machine;");
  return new Function("createTlaMachine", "tlaEqual", "tlaExcept", "tlaInRange", generated)(createTlaMachine, tlaEqual, tlaExcept, tlaInRange) as
    ReturnType<typeof createTlaMachine<{ count: number }, string>>;
}

describe("TLA+ source as an executable machine", () => {
  it("generates typed imports and a production transition from the same TLA+ source", async () => {
    const compiled = compileTlaSource(source);
    expect(compiled.declarations).toContain('export type Command = "go" | "finish"');
    expect(compiled.declarations).toContain('export type State = { "count": 0 | 1 | 2 }');
    expect(mapTlaSource(source)).toMatchObject({ extension: ".ts", text: compiled.declarations, mappings: [] });
    expect(chiselTla().transform(source, "counter.tla")).toBe(compiled.code);
    expect(chiselTla().transform(source, "other.ts")).toBeNull();
    const machine = execute(source);
    expect(machine.transition({ count: 0 }, "go")).toMatchObject({ state: { count: 2 }, steps: [{ command: "go" }, { command: "finish" }] });
    expect(() => machine.transition({ count: 2 }, "nope")).toThrow("CommandDomain");
    expect(() => machine.transition({ count: 0 }, "go", { maxCommands: 1 })).toThrow("maxCommands");
    expect((await checkTlaSource(source)).status).toBe("success");
  }, 15_000);

  it("supports CASE, LET and immutable EXCEPT record updates", () => {
    const modified = source.replace('IF s.count < 2 THEN s.count + 1 ELSE s.count',
      'LET next == s.count + 1 IN CASE s.count < 2 -> next [] OTHER -> s.count');
    expect(execute(modified).transition({ count: 0 }, "go").state).toEqual({ count: 2 });
    const replaced = source.replace('[count |-> IF s.count < 2 THEN s.count + 1 ELSE s.count]',
      '[s EXCEPT !.count = IF s.count < 2 THEN s.count + 1 ELSE s.count]');
    expect(execute(replaced).transition({ count: 0 }, "finish").state).toEqual({ count: 1 });
  });

  it("rejects nondeterministic or unsupported transitions with a location and useful guidance", () => {
    const invalid = source.replace('IF s.count < 2 THEN s.count + 1 ELSE s.count', 'CHOOSE n \\in 0..2 : n > s.count');
    expect(() => compileTlaSource(invalid)).toThrow(/Cannot generate runtime from TLA\+.* at \d+:\d+.*deterministic transitions/);
  });
});
