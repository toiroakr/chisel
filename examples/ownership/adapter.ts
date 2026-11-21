import type { Infer } from "../../src/runtime.js";
import type { ownsDesired } from "./owns-desired.js";
import type { DeployOwner } from "./sdk-reference.js";

type Input = Infer<(typeof ownsDesired)["input"]>;
type Labels = Record<string, string> | undefined;
type Label = { state: "absent" } | { state: "given"; value: string };

const label = (value: string | undefined): Label => (value ? { state: "given", value } : { state: "absent" });

// The model's input for what a deploy reads: the metadata labels of the
// existing resource and the owner the deploy manages resources for.
export function inputOf(labels: Labels, owner: DeployOwner): Input {
  const read = labels === undefined ? { metadata: "none" as const } : {
    metadata: "attached" as const,
    workspaceManaged: labels["sdk-managed"] === "workspace",
    sdkName: label(labels["sdk-name"]),
    sdkAppId: label(labels["sdk-app-id"]),
  };
  return owner.kind === "workspace"
    ? { owner: "workspace", labels: read }
    : { owner: "application", name: owner.name, appIdLabel: label(owner.id === undefined ? undefined : `app-${owner.id}`), labels: read };
}

// The labels and owner a row of the model stands for.
export function deployOf(input: Input): { labels: Labels; owner: DeployOwner } {
  const read = input.labels;
  const labels = read.metadata === "none" ? undefined : {
    ...(read.workspaceManaged && { "sdk-managed": "workspace" }),
    ...(read.sdkName.state === "given" && { "sdk-name": read.sdkName.value }),
    ...(read.sdkAppId.state === "given" && { "sdk-app-id": read.sdkAppId.value }),
  };
  const owner: DeployOwner = input.owner === "workspace" ? { kind: "workspace" }
    : { kind: "application", name: input.name, id: input.appIdLabel.state === "given" ? input.appIdLabel.value.replace(/^app-/, "") : undefined };
  return { labels, owner };
}
