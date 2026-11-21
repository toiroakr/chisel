import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { performSync } from "../src/runtime.js";
import { examples, specification } from "../examples/ownership/owns-desired.spec.js";
import { ownsDesiredModel } from "../examples/ownership/owns-desired.js";
import { deployOf, inputOf } from "../examples/ownership/adapter.js";
import { ownsDesired, type DeployOwner } from "../examples/ownership/sdk-reference.js";

describe("the ownership check of a deploy, as a model", () => {
  it("is adequate", async () => {
    const report = await c.check(specification);
    expect(report.verdict).toBe("satisfied");
  });

  it("agrees with the sdk's code on every row", async () => {
    expect(await c.test(examples, given => {
      const { labels, owner } = deployOf(given);
      return { result: ownsDesired(labels, owner), effects: [] };
    })).toStrictEqual({ failures: [], skipped: [] });
  });

  it("answers what the sdk's code answers for every label and owner it is handed", () => {
    const choices = <T>(...values: T[]) => values;
    const owners: DeployOwner[] = [
      { kind: "workspace" },
      { kind: "application", name: "shop", id: "1" },
      { kind: "application", name: "shop", id: undefined },
      { kind: "application", name: "blog", id: "2" },
    ];
    let compared = 0;
    for (const attached of [false, true]) for (const managed of choices(undefined, "workspace", "other"))
      for (const name of choices(undefined, "", "shop", "blog")) for (const appId of choices(undefined, "", "app-1", "app-2")) {
        if (!attached && (managed ?? name ?? appId) !== undefined) continue;
        const labels = !attached ? undefined : {
          ...(managed !== undefined && { "sdk-managed": managed }),
          ...(name !== undefined && { "sdk-name": name }),
          ...(appId !== undefined && { "sdk-app-id": appId }),
        };
        for (const owner of owners) {
          expect(performSync(ownsDesiredModel, inputOf(labels, owner)).result, JSON.stringify({ labels, owner })).toStrictEqual(ownsDesired(labels, owner));
          compared++;
        }
      }
    expect(compared).toBe(4 * (1 + 3 * 4 * 4));
  });
});
