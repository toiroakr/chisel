import * as c from "../../src/index.js";

const State = c.object({ label: c.enum(["none", "in-progress", "checkpoint"] as const), migrated: c.boolean() });
const Command = c.enum(["deploy"] as const);
type Deploy = c.Infer<typeof State>;

export const deploy = c.machine("fixture deploy", {
  state: State, command: Command, initial: [{ label: "none", migrated: false }],
  update: state => ({
    effects: [
      c.effect<Deploy>("writeLabel", { label: "in-progress" as const, migrated: state.migrated }),
      c.effect<Deploy>("runScript", { label: "in-progress" as const, migrated: true }),
      c.effect<Deploy>("writeLabel", { label: "checkpoint" as const, migrated: true }),
    ],
  }),
});
