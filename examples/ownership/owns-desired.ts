import * as c from "../../src/runtime.js";

// A label the deploy reads: absent, or holding a value. A label holding "" is
// read as absent, as the deploy reads it.
const label = c.variants("state", { absent: c.object({}), given: c.object({ value: c.string().min(1) }) });
// The label an application's id is written as: "app-" and the id.
const appIdLabel = c.variants("state", { absent: c.object({}), given: c.object({ value: c.string().min(5) }) });

const metadata = c.variants("metadata", {
  none: c.object({}),
  attached: c.object({ workspaceManaged: c.boolean(), sdkName: label, sdkAppId: label }),
});

export const ownsDesired = c.behavior("owns-desired", {
  description: "Whether a deploy plans a same-named resource that already exists, and what it must confirm otherwise",
  input: c.variants("owner", {
    application: c.object({ name: c.string(), appIdLabel, labels: metadata }),
    workspace: c.object({ labels: metadata }),
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
type Label = c.Infer<typeof label>;
type Attached = Extract<c.Infer<typeof metadata>, { metadata: "attached" }>;

const owned: Verdict = { verdict: "owned" };
const unmanaged: Verdict = { verdict: "unmanaged" };

export const ownsDesiredModel = c.implement(ownsDesired, {
  cases: {
    application: c.model("application owns", input => {
      const conflictOrUnmanaged = (name: c.TermOf<Label>) => c.matchValue<typeof label, Verdict>(label, name, {
        given: owner => ({ verdict: "conflict", currentOwner: owner.value }),
        absent: () => unmanaged,
      });
      return {
        result: c.matchValue<typeof metadata, Verdict>(metadata, input.labels, {
          none: () => unmanaged,
          attached: (labels: c.TermOf<Attached>) => c.matchValue<typeof label, Verdict>(label, labels.sdkAppId, {
            given: appId => c.matchValue<typeof appIdLabel, Verdict>(appIdLabel, input.appIdLabel, {
              given: id => c.choose(appId.value.$eq(id.value), owned, conflictOrUnmanaged(labels.sdkName)),
              absent: () => conflictOrUnmanaged(labels.sdkName),
            }),
            absent: () => c.matchValue<typeof label, Verdict>(label, labels.sdkName, {
              given: name => c.choose<Verdict>(name.value.$eq(input.name), owned, { verdict: "conflict", currentOwner: name.value }),
              absent: () => unmanaged,
            }),
          }),
        }),
        effects: [],
      };
    }),
    workspace: c.model("workspace owns", input => ({
      result: c.matchValue<typeof metadata, Verdict>(metadata, input.labels, {
        none: () => unmanaged,
        attached: (labels: c.TermOf<Attached>) => c.choose(
          labels.workspaceManaged.$eq(true),
          owned,
          c.matchValue<typeof label, Verdict>(label, labels.sdkName, {
            given: name => ({ verdict: "takeover", currentOwner: name.value }),
            absent: () => c.matchValue<typeof label, Verdict>(label, labels.sdkAppId, {
              given: () => ({ verdict: "takeover" }),
              absent: () => unmanaged,
            }),
          }),
        ),
      }),
      effects: [],
    })),
  },
});
