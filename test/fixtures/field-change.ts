// Which changes of a database field break the rows stored before it, and what a migration loosens
// while it rewrites them: nine independent verdicts and four relaxations in one answer, the shape
// whose ways multiply when every choice of the answer is combined with every other.
import * as c from "../../src/index.js";

const KeyField = c.variants("kind", { id: c.object({}), named: c.object({ name: c.string() }) });
const Target = c.variants("kind", { none: c.object({}), to: c.object({ table: c.string(), key: KeyField }) });
const Scale = c.variants("kind", { none: c.object({}), set: c.object({ digits: c.int() }) });
const Field = c.object({
  type: c.string(), required: c.boolean(), unique: c.boolean(), array: c.boolean(), serial: c.boolean(),
  vector: c.boolean(), foreignKey: c.boolean(), target: Target, scale: Scale, values: c.array(c.string()),
});
const Renamed = c.variants("kind", { none: c.object({}), to: c.object({ table: c.string() }) });
export const Change = c.variants("kind", {
  added: c.object({ after: Field, nested: c.boolean() }),
  modified: c.object({ before: Field, after: Field, nested: c.boolean(), renamed: Renamed }),
});
const Verdict = c.enum(["holds", "unsupported", "none"]);
const RULES = ["typeChanged", "arrayChanged", "targetMoved", "targetAdded", "requiredAdded", "madeRequired", "scaleChanged", "uniqueAdded", "valuesRemoved"] as const;
const Outcome = c.object({
  breaks: c.object(Object.fromEntries(RULES.map(id => [id, Verdict])) as Record<(typeof RULES)[number], typeof Verdict>),
  relax: c.object({ optional: c.boolean(), notUnique: c.boolean(), withoutTarget: c.boolean(), previousValues: c.boolean() }),
});
const IN_PLACE = ["boolean:string", "decimal:float", "decimal:string", "enum:string", "float:decimal", "float:string", "integer:decimal", "integer:float", "integer:string", "uuid:string"];

type F = c.TermOf<c.Infer<typeof Field>>;
type R = ReturnType<F["required"]["$eq"]>;
const hasTarget = (f: F): R => f.target.kind.$eq("to");
const keysDiffer = (b: F, a: F): R => b.target.key.kind.$ne(a.target.key.kind)
  .$or(b.target.key.kind.$eq("named").$and(a.target.key.kind.$eq("named")).$and(b.target.key.name.$ne(a.target.key.name)));
const moves = (b: F, a: F): R => hasTarget(b).$and(hasTarget(a)).$and(b.target.table.$ne(a.target.table).$or(keysDiffer(b, a)));
const inPlace = (b: F, a: F): R => b.array.$eq(false).$and(a.array.$eq(false)).$and(b.type.$ne("nested")).$and(a.type.$ne("nested"))
  .$and(b.serial.$eq(false)).$and(a.serial.$eq(false)).$and(b.vector.$eq(false)).$and(a.vector.$eq(false))
  .$and(b.foreignKey.$eq(false)).$and(a.foreignKey.$eq(false))
  .$and(IN_PLACE.map(pair => { const [from = "", to = ""] = pair.split(":"); return b.type.$eq(from).$and(a.type.$eq(to)); }).reduce((x, y) => x.$or(y)))
  .$and(b.unique.$eq(false).$or(a.type.$ne("decimal")).$or(b.type.$ne("float")));
const verdict = (breaks: R, unsupported: R) => c.choose(breaks, c.choose(unsupported, "unsupported" as const, "holds" as const), "none" as const);
const holds = (breaks: R) => c.choose(breaks, "holds" as const, "none" as const);
const when = (rule: R) => c.choose(rule, true, false);

export const fieldChange = c.behavior("field change", {
  input: Change, result: Outcome, effects: c.variants("kind", {}),
  ensures: clause => [
    clause.always("never requires a value stored rows may lack", (change, outcome) =>
      change.after.required.$eq(false).$or(outcome.relax.optional.$eq(true)).$or(change.kind.$eq("modified").$and(change.before.required.$eq(true)))),
    clause.always("never demands uniqueness stored rows may break", (change, outcome) =>
      change.after.unique.$eq(false).$or(outcome.relax.notUnique.$eq(true)).$or(change.kind.$eq("added")).$or(change.before.unique.$eq(true))),
  ],
});

export const fieldChangeRules = c.implement(fieldChange, {
  cases: {
    added: c.model("added field", change => ({
      result: {
        breaks: { typeChanged: "none" as const, arrayChanged: "none" as const, targetMoved: "none" as const, targetAdded: "none" as const,
          requiredAdded: holds(change.after.required.$eq(true)), madeRequired: "none" as const, scaleChanged: "none" as const,
          uniqueAdded: "none" as const, valuesRemoved: "none" as const },
        relax: { optional: when(change.after.required.$eq(true)), notUnique: false, withoutTarget: false, previousValues: false },
      },
      effects: [],
    })),
    modified: c.model("modified field", change => {
      const { before: b, after: a } = change;
      const added = change.nested.$eq(false).$and(b.target.kind.$eq("none")).$and(hasTarget(a));
      const madeRequired = b.required.$eq(false).$and(a.required.$eq(true));
      const uniqueAdded = b.unique.$eq(false).$and(a.unique.$eq(true));
      const removed = b.type.$eq("enum").$and(a.type.$eq("enum")).$and(b.values.$any(v => a.values.$all(k => k.$ne(v))));
      return {
        result: {
          breaks: {
            typeChanged: verdict(b.type.$ne(a.type), change.nested.$eq(true).$or(inPlace(b, a).$not())),
            arrayChanged: c.choose(b.array.$ne(a.array), "unsupported" as const, "none" as const),
            targetMoved: verdict(moves(b, a).$and(keysDiffer(b, a).$or(change.renamed.kind.$eq("none")).$or(change.renamed.table.$ne(a.target.table))), change.nested.$eq(true)),
            targetAdded: holds(added),
            requiredAdded: "none" as const,
            madeRequired: holds(madeRequired),
            scaleChanged: verdict(b.type.$eq("decimal").$and(a.type.$eq("decimal")).$and(b.scale.kind.$ne(a.scale.kind)
              .$or(b.scale.kind.$eq("set").$and(a.scale.kind.$eq("set")).$and(b.scale.digits.$ne(a.scale.digits)))), change.nested.$eq(true)),
            uniqueAdded: holds(uniqueAdded),
            valuesRemoved: holds(removed),
          },
          relax: { optional: when(madeRequired), notUnique: when(uniqueAdded), withoutTarget: when(moves(b, a).$or(added)), previousValues: when(removed) },
        },
        effects: [],
      };
    }),
  },
});
