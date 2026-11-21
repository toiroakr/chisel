import * as c from "../../src/runtime.js";

// What sdk-name, sdk-app-id and sdk-managed say, as the deploy reads them: a
// label holding "" counts as absent, so "given" holds a non-empty value.
const label = c.object({ given: c.boolean(), value: c.string() })
  .refine("an absent label holds nothing", v => v.given.$eq(true).$or(v.value.$eq("")))
  .refine("a given label holds a value", v => v.given.$eq(false).$or(v.value.$length().$gte(1)));

const labels = c.object({
  attached: c.boolean(),
  workspaceManaged: c.boolean(),
  sdkName: label,
  sdkAppId: label,
}).refine("a resource without metadata carries no label", v =>
  v.attached.$eq(true).$or(v.workspaceManaged.$eq(false).$and(v.sdkName.given.$eq(false)).$and(v.sdkAppId.given.$eq(false))));

export const ownsDesired = c.behavior("owns-desired", {
  description: "Whether a deploy plans a same-named resource that already exists, and what it must confirm otherwise",
  input: c.variants("owner", {
    application: c.object({ name: c.string(), appIdLabel: label, labels }),
    workspace: c.object({ labels }),
  }),
  result: c.variants("verdict", {
    owned: c.object({}),
    takeover: c.object({ currentOwner: c.string().optional() }),
    conflict: c.object({ currentOwner: c.string() }),
    unmanaged: c.object({}),
  }),
  effects: c.variants("kind", {}),
});

type Verdict = c.Infer<typeof ownsDesired.result>;

export const ownsDesiredModel = c.implement(ownsDesired, {
  cases: {
    application: c.model("application owns", input => {
      const { labels: l } = input;
      const ownedById = l.sdkAppId.given.$eq(true).$and(input.appIdLabel.given.$eq(true)).$and(l.sdkAppId.value.$eq(input.appIdLabel.value));
      const ownedByName = l.sdkAppId.given.$eq(false).$and(l.sdkName.given.$eq(true)).$and(l.sdkName.value.$eq(input.name));
      return {
        result: c.choose<Verdict>(
          l.attached.$eq(true).$and(ownedById.$or(ownedByName)),
          { verdict: "owned" },
          c.choose<Verdict>(
            l.attached.$eq(true).$and(l.sdkName.given.$eq(true)),
            { verdict: "conflict", currentOwner: l.sdkName.value },
            { verdict: "unmanaged" },
          ),
        ),
        effects: [],
      };
    }),
    workspace: c.model("workspace owns", input => {
      const { labels: l } = input;
      return {
        result: c.choose<Verdict>(
          l.attached.$eq(true).$and(l.workspaceManaged.$eq(true)),
          { verdict: "owned" },
          c.choose<Verdict>(
            l.attached.$eq(true).$and(l.sdkName.given.$eq(true).$or(l.sdkAppId.given.$eq(true))),
            c.choose<Verdict>(l.sdkName.given.$eq(true), { verdict: "takeover", currentOwner: l.sdkName.value }, { verdict: "takeover" }),
            { verdict: "unmanaged" },
          ),
        ),
        effects: [],
      };
    }),
  },
});
