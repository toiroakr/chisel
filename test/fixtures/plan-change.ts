// What a change of a subscription plan sets off, and what the account keeps until the change has
// settled: nine independent verdicts and four allowances in one answer, the shape whose ways
// multiply when every choice of the answer is combined with every other.
import * as c from "../../src/index.js";

const Account = c.variants("kind", { default: c.object({}), named: c.object({ name: c.string() }) });
const Billing = c.variants("kind", { none: c.object({}), card: c.object({ issuer: c.string(), account: Account }) });
const Discount = c.variants("kind", { none: c.object({}), set: c.object({ percent: c.int() }) });
const Plan = c.object({
  tier: c.string(), invoiced: c.boolean(), dedicated: c.boolean(), team: c.boolean(), legacy: c.boolean(),
  trial: c.boolean(), reseller: c.boolean(), billing: Billing, discount: Discount, features: c.array(c.string()),
});
const Transfer = c.variants("kind", { none: c.object({}), to: c.object({ issuer: c.string() }) });
export const Change = c.variants("kind", {
  started: c.object({ after: Plan, gift: c.boolean() }),
  changed: c.object({ before: Plan, after: Plan, gift: c.boolean(), transfer: Transfer }),
});
const Verdict = c.enum(["holds", "manual", "none"]);
const VERDICTS = ["tierChanged", "teamChanged", "billingMoved", "billingAdded", "invoiceStarted", "madeInvoiced", "discountChanged", "dedicatedAdded", "featuresRemoved"] as const;
const Outcome = c.object({
  sets: c.object(Object.fromEntries(VERDICTS.map(id => [id, Verdict])) as Record<(typeof VERDICTS)[number], typeof Verdict>),
  keeps: c.object({ uninvoiced: c.boolean(), shared: c.boolean(), billing: c.boolean(), features: c.boolean() }),
});
const UPGRADES = ["basic:plus", "basic:pro", "basic:team", "plus:pro", "plus:team", "pro:team", "trial:basic", "trial:plus", "trial:pro", "trial:team"];

type P = c.TermOf<c.Infer<typeof Plan>>;
type R = ReturnType<P["invoiced"]["$eq"]>;
const hasCard = (p: P): R => p.billing.kind.$eq("card");
const accountsDiffer = (b: P, a: P): R => b.billing.account.kind.$ne(a.billing.account.kind)
  .$or(b.billing.account.kind.$eq("named").$and(a.billing.account.kind.$eq("named")).$and(b.billing.account.name.$ne(a.billing.account.name)));
const moves = (b: P, a: P): R => hasCard(b).$and(hasCard(a)).$and(b.billing.issuer.$ne(a.billing.issuer).$or(accountsDiffer(b, a)));
const upgrade = (b: P, a: P): R => b.team.$eq(false).$and(a.team.$eq(false)).$and(b.tier.$ne("custom")).$and(a.tier.$ne("custom"))
  .$and(b.legacy.$eq(false)).$and(a.legacy.$eq(false)).$and(b.trial.$eq(false)).$and(a.trial.$eq(false))
  .$and(b.reseller.$eq(false)).$and(a.reseller.$eq(false))
  .$and(UPGRADES.map(pair => { const [from = "", to = ""] = pair.split(":"); return b.tier.$eq(from).$and(a.tier.$eq(to)); }).reduce((x, y) => x.$or(y)))
  .$and(b.dedicated.$eq(false).$or(a.tier.$ne("team")).$or(b.tier.$ne("pro")));
const verdict = (sets: R, manual: R) => c.choose(sets, c.choose(manual, "manual" as const, "holds" as const), "none" as const);
const holds = (sets: R) => c.choose(sets, "holds" as const, "none" as const);
const when = (rule: R) => c.choose(rule, true, false);

export const planChange = c.behavior("plan change", {
  input: Change, result: Outcome, effects: c.variants("kind", {}),
  ensures: clause => [
    clause.always("never invoices an account that was not invoiced", (change, outcome) =>
      change.after.invoiced.$eq(false).$or(outcome.keeps.uninvoiced.$eq(true)).$or(change.kind.$eq("changed").$and(change.before.invoiced.$eq(true)))),
    clause.always("never takes a shared account to a dedicated one at once", (change, outcome) =>
      change.after.dedicated.$eq(false).$or(outcome.keeps.shared.$eq(true)).$or(change.kind.$eq("started")).$or(change.before.dedicated.$eq(true))),
    clause.always("never drops a feature the account still uses", (change, outcome) =>
      change.kind.$eq("started").$or(outcome.keeps.features.$eq(true))
        .$or(change.before.features.$all(feature => change.after.features.$any(kept => kept.$eq(feature))))),
  ],
});

export const planChangeRules = c.implement(planChange, {
  cases: {
    started: c.model("started plan", change => ({
      result: {
        sets: { tierChanged: "none" as const, teamChanged: "none" as const, billingMoved: "none" as const, billingAdded: "none" as const,
          invoiceStarted: holds(change.after.invoiced.$eq(true)), madeInvoiced: "none" as const, discountChanged: "none" as const,
          dedicatedAdded: "none" as const, featuresRemoved: "none" as const },
        keeps: { uninvoiced: when(change.after.invoiced.$eq(true)), shared: false, billing: false, features: false },
      },
      effects: [],
    })),
    changed: c.model("changed plan", change => {
      const { before: b, after: a } = change;
      const added = change.gift.$eq(false).$and(b.billing.kind.$eq("none")).$and(hasCard(a));
      const madeInvoiced = b.invoiced.$eq(false).$and(a.invoiced.$eq(true));
      const dedicatedAdded = b.dedicated.$eq(false).$and(a.dedicated.$eq(true));
      const removed = b.features.$any(feature => a.features.$all(kept => kept.$ne(feature)));
      return {
        result: {
          sets: {
            tierChanged: verdict(b.tier.$ne(a.tier), change.gift.$eq(true).$or(upgrade(b, a).$not())),
            teamChanged: c.choose(b.team.$ne(a.team), "manual" as const, "none" as const),
            billingMoved: verdict(moves(b, a).$and(accountsDiffer(b, a).$or(change.transfer.kind.$eq("none")).$or(change.transfer.issuer.$ne(a.billing.issuer))), change.gift.$eq(true)),
            billingAdded: holds(added),
            invoiceStarted: "none" as const,
            madeInvoiced: holds(madeInvoiced),
            discountChanged: verdict(b.tier.$eq("pro").$and(a.tier.$eq("pro")).$and(b.discount.kind.$ne(a.discount.kind)
              .$or(b.discount.kind.$eq("set").$and(a.discount.kind.$eq("set")).$and(b.discount.percent.$ne(a.discount.percent)))), change.gift.$eq(true)),
            dedicatedAdded: holds(dedicatedAdded),
            featuresRemoved: holds(removed),
          },
          keeps: { uninvoiced: when(madeInvoiced), shared: when(dedicatedAdded), billing: when(moves(b, a).$or(added)), features: when(removed) },
        },
        effects: [],
      };
    }),
  },
});
