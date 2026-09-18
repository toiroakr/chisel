import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defineSpecification,
  evaluateSpecification,
  examples,
  generateExamples,
} from "../src/index.js";
import { 予約をキャンセルする as 段階1の振る舞い } from "../examples/progressive-demo/stage-01-sketch.spec.js";
import { 最初の回答 } from "../examples/progressive-demo/stage-02-first-answer.spec.js";
import { 詳細化した仕様 } from "../examples/progressive-demo/stage-03-refined.spec.js";
import { 完成した仕様 } from "../examples/progressive-demo/stage-04-complete.spec.js";

describe("progressive specification demo", () => {
  it("moves from explicit gaps to an accepted specification", async () => {
    const 段階1のスケッチ = defineSpecification({
      name: "段階1",
      examples: examples(段階1の振る舞い, []),
    });
    const 段階1 = await evaluateSpecification(段階1のスケッチ);
    const 段階2 = await evaluateSpecification(最初の回答);
    const 段階3 = await evaluateSpecification(詳細化した仕様);
    const 段階4 = await evaluateSpecification(完成した仕様);

    assert.equal(段階1.adequate, false);
    assert.deepEqual(段階1.input.missing, [
      "受付済み",
      "予約確定",
      "チェックイン済み",
      "キャンセル済み",
    ]);
    assert.deepEqual(generateExamples(段階1の振る舞い).map(row => row.given), [
      { 状態: "受付済み", 予約ID: "<予約ID>" },
      {
        状態: "予約確定",
        予約ID: "<予約ID>",
        決済ID: "<決済ID>",
      },
      { 状態: "チェックイン済み", 予約ID: "<予約ID>" },
      { 状態: "キャンセル済み", 予約ID: "<予約ID>" },
    ]);

    assert.equal(段階2.adequate, false);
    assert.deepEqual(段階2.input.missing, []);
    assert.equal(段階2.implementation, "missing");

    assert.equal(段階3.adequate, false);
    assert.deepEqual(段階3.input.missing, ["返金不可な予約"]);
    assert.equal(段階3.implementation, "missing");

    assert.equal(段階4.adequate, true);
  });
});
