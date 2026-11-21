// The ownership check of a deploy as tailor-platform/sdk writes it
// (packages/sdk/src/cli/commands/deploy/label.ts and owned-resource.ts), reduced
// to the verdict, for the model to be held against.
type Labels = Record<string, string> | undefined;
export type DeployOwner = { kind: "application"; name: string; id: string | undefined } | { kind: "workspace" };
export type Verdict =
  | { verdict: "owned" }
  | { verdict: "takeover"; currentOwner?: string }
  | { verdict: "conflict"; currentOwner: string }
  | { verdict: "unmanaged" };

const isWorkspaceManaged = (labels: Labels) => labels?.["sdk-managed"] === "workspace";
const deployedByApplication = (labels: Labels) =>
  Boolean(labels && !isWorkspaceManaged(labels) && (labels["sdk-name"] || labels["sdk-app-id"]));

function isOwnedByApp(labels: Labels, appName: string, appId: string | undefined): boolean {
  if (!labels) return false;
  const labelAppId = labels["sdk-app-id"];
  if (labelAppId) return appId !== undefined && labelAppId === `app-${appId}`;
  return labels["sdk-name"] === appName;
}

const isOwnedBy = (labels: Labels, owner: DeployOwner) =>
  owner.kind === "workspace" ? isWorkspaceManaged(labels) : isOwnedByApp(labels, owner.name, owner.id);

export function ownsDesired(labels: Labels, owner: DeployOwner): Verdict {
  if (isOwnedBy(labels, owner)) return { verdict: "owned" };
  const currentOwner = labels?.["sdk-name"];
  if (owner.kind === "workspace" && labels && deployedByApplication(labels)) {
    return { verdict: "takeover", ...(currentOwner && { currentOwner }) };
  }
  if (owner.kind === "application" && currentOwner) return { verdict: "conflict", currentOwner };
  return { verdict: "unmanaged" };
}
