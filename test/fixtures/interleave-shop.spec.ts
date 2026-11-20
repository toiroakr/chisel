import * as c from "../../src/index.js";

const Stock = c.object({ stock: c.int().min(0).max(1), a: c.boolean(), b: c.boolean() });
type Shop = c.Infer<typeof Stock>;
const Buy = c.variants("type", { buy: c.object({ customer: c.enum(["a", "b"] as const) }) });

const shop = (ifUnchanged: boolean, name: string) => c.machine(name, {
  state: Stock, command: Buy, initial: [{ stock: 1, a: false, b: false }],
  update: ((state: c.TermOf<Shop>, command: c.TermOf<{ customer: string }>) => ({
    effects: c.choose<readonly c.Effect<Shop>[]>(state.stock.$gte(1), [
      c.effect<Shop>("take", {
        stock: state.stock.$minus(1),
        a: c.choose<boolean>(command.customer.$eq("a"), true, state.a),
        b: c.choose<boolean>(command.customer.$eq("b"), true, state.b),
      }, { ifUnchanged }),
    ], []),
  })) as never,
});

const once = c.invariant<Shop>("the last unit is sold once", state => state.a.$eq(false).$or(state.b.$eq(false)));
const interleavings = { copies: [{ type: "buy" as const, customer: "a" as const }, { type: "buy" as const, customer: "b" as const }] };

export const unguarded = c.specifyMachine(shop(false, "unguarded shop"), { invariants: [once], interleavings });
export const guarded = c.specifyMachine(shop(true, "guarded shop"), { invariants: [once], interleavings });
