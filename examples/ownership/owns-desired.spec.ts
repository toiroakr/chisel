import * as c from "../../src/index.js";
import { ownsDesired, ownsDesiredModel } from "./owns-desired.js";

const none = { state: "absent" } as const;
const given = (value: string) => ({ state: "given", value }) as const;
const attached = (labels: { workspaceManaged?: boolean; sdkName?: string; sdkAppId?: string }) => ({
  metadata: "attached",
  workspaceManaged: labels.workspaceManaged ?? false,
  sdkName: labels.sdkName === undefined ? none : given(labels.sdkName),
  sdkAppId: labels.sdkAppId === undefined ? none : given(labels.sdkAppId),
}) as const;
const detached = { metadata: "none" } as const;
const result = <R>(value: R) => ({ result: value, effects: [] });

export const examples = c.examples(ownsDesired, {
  "an application owns nothing without labels": {
    given: { owner: "application", name: "shop", appIdLabel: given("app-1"), labels: detached },
    expect: result({ verdict: "unmanaged" }),
  },
  "an application owns what carries its id": {
    given: { owner: "application", name: "shop", appIdLabel: given("app-12"), labels: attached({ sdkName: "renamed", sdkAppId: "app-12" }) },
    expect: result({ verdict: "owned" }),
  },
  "another application's id is a conflict even under the same name": {
    given: { owner: "application", name: "shop", appIdLabel: given("app-1"), labels: attached({ sdkName: "shop", sdkAppId: "app-2" }) },
    expect: result({ verdict: "conflict", currentOwner: "shop" }),
  },
  "an application without an id owns nothing carrying one": {
    given: { owner: "application", name: "shop", appIdLabel: none, labels: attached({ sdkName: "shop", sdkAppId: "app-1" }) },
    expect: result({ verdict: "conflict", currentOwner: "shop" }),
  },
  "an application without an id leaves an id with no name unmanaged": {
    given: { owner: "application", name: "shop", appIdLabel: none, labels: attached({ sdkAppId: "app-1" }) },
    expect: result({ verdict: "unmanaged" }),
  },
  "an id with no name is unmanaged to another application": {
    given: { owner: "application", name: "shop", appIdLabel: given("app-1"), labels: attached({ sdkAppId: "x" }) },
    expect: result({ verdict: "unmanaged" }),
  },
  "without an id label, the name decides": {
    given: { owner: "application", name: "shop", appIdLabel: given("app-1"), labels: attached({ sdkName: "shop" }) },
    expect: result({ verdict: "owned" }),
  },
  "another name is a conflict": {
    given: { owner: "application", name: "shop", appIdLabel: none, labels: attached({ sdkName: "b" }) },
    expect: result({ verdict: "conflict", currentOwner: "b" }),
  },
  "labels from no SDK are unmanaged": {
    given: { owner: "application", name: "shop", appIdLabel: none, labels: attached({}) },
    expect: result({ verdict: "unmanaged" }),
  },
  "an application without an id owns nothing without labels": {
    given: { owner: "application", name: "shop", appIdLabel: none, labels: detached },
    expect: result({ verdict: "unmanaged" }),
  },
  "an application reads no workspace mark": {
    given: { owner: "application", name: "shop", appIdLabel: given("app-1"), labels: attached({ workspaceManaged: true, sdkName: "shop", sdkAppId: "app-1" }) },
    expect: result({ verdict: "owned" }),
  },
  "a workspace mark alone is unmanaged to an application": {
    given: { owner: "application", name: "shop", appIdLabel: none, labels: attached({ workspaceManaged: true }) },
    expect: result({ verdict: "unmanaged" }),
  },
  "the workspace owns nothing without labels": {
    given: { owner: "workspace", labels: detached },
    expect: result({ verdict: "unmanaged" }),
  },
  "the workspace owns what it marked": {
    given: { owner: "workspace", labels: attached({ workspaceManaged: true, sdkName: "shop" }) },
    expect: result({ verdict: "owned" }),
  },
  "the workspace owns what it marked, with no name": {
    given: { owner: "workspace", labels: attached({ workspaceManaged: true }) },
    expect: result({ verdict: "owned" }),
  },
  "the workspace owns what it marked over an application's labels": {
    given: { owner: "workspace", labels: attached({ workspaceManaged: true, sdkName: "shop", sdkAppId: "app-1" }) },
    expect: result({ verdict: "owned" }),
  },
  "the workspace takes over what an application deployed": {
    given: { owner: "workspace", labels: attached({ sdkName: "s" }) },
    expect: result({ verdict: "takeover", currentOwner: "s" }),
  },
  "the workspace takes over what an application deployed by id only": {
    given: { owner: "workspace", labels: attached({ sdkAppId: "x" }) },
    expect: result({ verdict: "takeover" }),
  },
  "the workspace leaves labels from no SDK unmanaged": {
    given: { owner: "workspace", labels: attached({}) },
    expect: result({ verdict: "unmanaged" }),
  },
});

export const specification = c.spec("owns-desired", { implementation: ownsDesiredModel, examples });
