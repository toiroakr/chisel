import * as c from "../src/runtime.js";

const State = c.object({
  phase: c.enum(["draft", "approved", "issued"] as const),
  ordered: c.int().min(1).max(2),
  received: c.int().min(0).max(2),
});
const Command = c.variants("type", {
  submit: c.object({}),
  allocate: c.object({}),
  receive: c.object({ units: c.int().min(1).max(2) }),
});

type Order = c.Infer<typeof State>;
type OrderCommand = c.Infer<typeof Command>;

export const orderMachine = c.machine("order fulfillment", {
  state: State,
  command: Command,
  initial: [{ phase: "draft", ordered: 2, received: 0 }],
  update: (state, command) => c.matchValue<typeof Command, { state: Order; commands: readonly OrderCommand[] }>(Command, command, {
    submit: () => ({
      state: {
        phase: c.choose<Order["phase"]>(state.phase.$eq("draft"), "approved", state.phase),
        ordered: state.ordered,
        received: state.received,
      },
      commands: [{ type: "allocate" as const }],
    }),
    allocate: () => ({
      state: {
        phase: c.choose<Order["phase"]>(state.phase.$eq("approved"), "issued", state.phase),
        ordered: state.ordered,
        received: state.received,
      },
      commands: [],
    }),
    receive: input => ({
      // A receipt before issuance or beyond the ordered quantity is deliberately a no-op.
      // The invariant describes reachable state, not command acceptance.
      state: {
        phase: state.phase,
        ordered: state.ordered,
        received: c.choose<number>(
          state.phase.$eq("issued").$and(state.received.$plus(input.units).$lte(state.ordered)),
          state.received.$plus(input.units),
          state.received,
        ),
      },
      commands: [],
    }),
  }),
});
