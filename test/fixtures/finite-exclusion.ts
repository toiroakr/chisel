import { behavior, enum as enumOf, object, variants } from "../../src/index.js";

export const 決まる = behavior("決まる", {
  input: variants("状態", {
    入力済み: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]) })
      .refine(v => v.甲.$eq("x").$or(v.乙.$eq("y")))
      .refine(v => v.甲.$ne("x").$or(v.乙.$eq("y"))),
  }),
  result: object({}),
  effects: variants("種類", {}),
});
