# Chisel

Chisel is an experimental TypeScript toolkit for growing an executable business specification from a closed data model, generated examples, and human-provided expectations.

The workflow is deliberately ordered:

```text
declare data and behavior
→ generate unanswered examples
→ let a human fill expected results
→ refine data and behavior
→ implement an executable model
→ check the model against the examples
```

## 1. Declare data and behavior

The examples import Chisel as a namespace, `import * as c from "chisel"`, the way zod and valibot are used as `z` and `v`; the names below are written without the prefix.

The first version describes the domain vocabulary and the behavior boundary, not its implementation. `variants(discriminant, { case: object(...) })` declares a discriminated union: a value is exactly one of the named cases, told apart by the discriminant field (Souther calls this a sum type). An `object` holds exactly the fields it declares: a value carrying another key is refused, not trimmed, so a model answering with a stray field fails `check` instead of passing it.

```ts
import * as c from "chisel";

const Order = c.variants("state", {
  unpaid: c.object({ orderId: c.string() }),
  paid: c.object({
    orderId: c.string(),
    paymentId: c.string(),
  }),
});

const CancelResult = c.variants("type", {
  accepted: c.object({ orderId: c.string() }),
  rejected: c.object({ reason: c.string() }),
});

const CancelEffect = c.variants("type", {
  refund: c.object({ paymentId: c.string() }),
  restock: c.object({ orderId: c.string() }),
});

export const cancelOrder = c.behavior("cancel-order", {
  input: Order,
  result: CancelResult,
  effects: CancelEffect,
});
```

## 2. Generate unanswered examples

```sh
chisel generate ./cancel-order.spec.ts
```

Chisel emits TypeScript rows for every uncovered input variant, then for every class and border point no row stands in yet (see [Analysis](#analysis)). The rows are written the way hand-written examples are (bare keys where the key is an identifier, trailing commas), so they paste as they are. For a behavior no `spec` wraps yet, the output also carries the `import` line, an implementation whose every case and control is `c.todo(...)`, and a `spec` block to paste after the behavior (a specification with no implementation gets the implementation scaffold too); for one that has a specification, only the rows are printed, ready to go into its `examples(...)` table.

```ts
export const cancelOrderExamples = c.examples(cancelOrder, {
  "cancel-order: unpaid": {
    given: {
      state: "unpaid",
      orderId: "<orderId>",
    },
    expect: c.todo(
      "Expected result for unpaid must be decided by a human",
    ),
  },
  "cancel-order: paid": {
    given: {
      state: "paid",
      orderId: "<orderId>",
      paymentId: "<paymentId>",
    },
    expect: c.todo(
      "Expected result for paid must be decided by a human",
    ),
  },
});
```

## 3. Fill expectations

A human replaces `todo()` with the expected result and effect trace. `todo(reason)` is the one marker for anything not decided yet: an answer here, and also a case of `implement` or an effect's control policy that is still open. `examples(behavior, { name: row })` is a table keyed by the row's name, which the report uses to point at a row; two rows with one name do not compile. Each row's `given` and `expect` are typed by the behavior, so a row that no longer fits the model fails to compile.

```ts
export const cancelOrderExamples = c.examples(cancelOrder, {
  "cancel a paid order": {
    given: {
      state: "paid",
      orderId: "o-1",
      paymentId: "p-1",
    },
    expect: {
      result: {
        type: "accepted",
        orderId: "o-1",
      },
      effects: [
        { type: "refund", paymentId: "p-1" },
        { type: "restock", orderId: "o-1" },
      ],
    },
  },
});
```

Where only the case of the answer is known, as an SOP's *then* says `status == Shipped` and nothing about the shipment it answers, the row writes the case with `c.caseOf(tag)` in place of the result, as Souther's bare case name `-> Shipped` does:

```ts
"ship a picked order": {
  given: { state: "picked", orderId: "o-1" },
  expect: {
    result: c.caseOf("shipped"),
    effects: [{ type: "notifyCustomer", orderId: "o-1" }],
  },
},
```

The answer is then compared by its case alone, and the effects still in full. The row specifies the `shipped` result case and verifies it when the model answers that case. An `ensures` clause, which reads the answer's value, is not held against such a row, since nothing wrote the value it would read; `c.test` compares production code's answer by the case too, and a fake row standing in for a behavior whose recorded row writes only the case agrees with it when it answers that case. A case the result does not have does not compile, and is refused as `Expected result is invalid`.

To build a row outside the table (a helper, or a row shared by several specifications), `example(behavior, { given, expect })` types it by the behavior, and it is put in a table under a name: `examples(cancelOrder, { "paid": paidRow })`. Rows are kept in the order written, except that names which are plain integers (`"1"`, `"100"`) come first, as JavaScript orders such keys.

Changing the data or behavior model makes stale examples fail to compile. Running `generate` again emits rows for newly introduced variants, classes and border points, each composed from an answered row with only the position in question moved.

## 4. Implement the model

Once expectations are known, `implement()` supplies the executable model: one `action(name, { guards?, run })` per input case. `run` computes the answer; `guards` (below) lists the conditions checked before it, each with the answer to give when it fails. The name is how reports refer to the action.

```ts
const implementation = c.implement(cancelOrder, {
  cases: {
    unpaid: c.action("cancel-unpaid", {
      run: order => ({
        result: { type: "accepted", orderId: order.orderId },
        effects: [{ type: "restock", orderId: order.orderId }],
      }),
    }),
    paid: c.action("cancel-paid", {
      run: order => ({
        result: { type: "accepted", orderId: order.orderId },
        effects: [
          { type: "refund", paymentId: order.paymentId },
          { type: "restock", orderId: order.orderId },
        ],
      }),
    }),
  },
  controls: {
    refund: {
      execution: "queue",
      idempotency: "required",
      compensation: "manual",
    },
    restock: {
      execution: "outbox",
      idempotency: "required",
      compensation: "automatic",
    },
  },
});

export const cancellation = c.spec("order cancellation", {
  examples: cancelOrderExamples,
  implementation,
});
```

## Commands

Chisel requires Node.js 26 or later and uses its built-in Temporal API.

```sh
npm install
npm run check
npm run demo
```

The built CLI can load TypeScript directly.

```sh
node dist/cli.js generate ./cancel-order.spec.ts
node dist/cli.js check ./cancel-order.spec.ts
node dist/cli.js check ./cancel-order.spec.ts --strict
```

`check` reports the current state without failing by default. `--strict` exits with status 1 while examples are unanswered, input/result/effect variants, classes or border points are uncovered, the implementation is absent or pending, control policies are incomplete, or the implementation disagrees with an example. It never fails because a measure could not be made: that is reported as an `undetermined` verdict instead.

## Progressive demo

The [hotel reservation demo](./examples/progressive-demo/README.md) runs the complete declaration → generation → human answer → refinement → implementation sequence.

```sh
npm run demo
```

## Analysis

The analyzer follows the example-adequacy model of [Souther](https://github.com/souther-lang/souther). It measures what the model itself states and nothing else:

- **Cases** of the input, result and effect variants. Evidence is graded: an input case is `specified` by a row, `executed` when the model ran on it and `verified` when the row held; a result or effect case is `specified`, `observed` or `verified`.
- **Classes** of each input position, derived from the types: an optional field (`c.string().optional()`) is absent or present, a `boolean` true or false, an `enum` one of its values (`c.enum(["draft", "submitted"])`, with what each means as `c.enum(["draft", "submitted"], { labels: { draft: "下書き", submitted: "申請中" } })`, a choice with nothing to carry, which a guard may compare with `$eq`/`$ne` and a `match` may select; ordering it with `$lt` and the like is listed as a comparison Chisel cannot read, since its values order by their text), a `variants` field one of its cases. A class an `eq`/`ne` invariant refuses is `excluded` and counted neither way, and so is one that invariants relating several booleans, enums or `variants` cases leave no combination for (`.refine(v => v.甲.$eq("x").$or(v.乙.$eq("y")))` with `.refine(v => v.甲.$ne("x").$or(v.乙.$eq("y")))` leave `乙` only `y`). The same holds for an input case an invariant on the input sum refuses (`variants(...).refine(v => v.state.$ne("archived"))`), and a rule on a field every case shares draws its border under each case. A position no rule draws a line through is `not derivable`, which is a fact about the model rather than a gap.
- **Borders** drawn by an invariant that compares a value or a `length` with a constant, with the four domain-testing points `ON`, `OFF`, `IN` and `OUT`. Outside an invariant nothing can be constructed, so `OFF` and `OUT` are excluded; `ON` and `IN` are owed a row. An invariant ordering two positions, such as `object({ 数量: c.int(), 上限: c.int() }).refine(v => v.数量.$lte(v.上限))`, draws its border on their difference (`@case.数量 − @case.上限`, `ON = 0` and `IN < 0` owed, `OFF = 1` and `OUT > 1` excluded), as Souther draws the border of a relation an input's type states, whether the case or an object one of its fields holds declares it (one comparing a field with itself draws none, and is reported as a model error when no value keeps it); an invariant on an answer draws none. `int`, lengths, instants and the calendar types have a neighbouring value (a `date` steps by a day, a `time` or `datetime` by a nanosecond); `number` and `string` do not, so their `OFF` point is not named. A point one bound owes is excluded when another bound refuses it, and bounds that leave nothing admitted (`$ >= 10` with `$ <= 5`) are reported as a model error rather than as gaps. A length is never negative, so a point that would lie below zero has no point there (`none: a length is never negative`) and no row is asked for at it, whether the border comes from an invariant or a guard. A `time` lies between `00:00` and `23:59:59.999999999` in the same way, so a point past either end is `none: a time of day lies within one day`.
- **The lines beside a border** over two or more fields, as Souther's E1938 asks: once every point a guard's border owes has a row, the rows that reached it may still fall on the same sides of a line one weight away, so that the guard could have been written as that line. For a guard `y <= 2 * x` whose rows all have `x = 0`, the report names `-@case.x + @case.y = 0` (`border.beside`, `not told`, printed as `隣の線 ! … と見分ける行がない`) and the specification is not adequate until a row the two lines answer differently at is written; each part's weight is moved by one up and then down, in the order of the fields' paths, and the first line the rows allow is named, with an input to write a row at (`beside.input`, `@case.x = 1, @case.y = 2` there): a step along the border from a row that the guards before it still let through, preferring one the other guards also keep and then the fewest steps, as Souther's hint does; `generate` offers a row there, named `隣の線 (…)`, or lists the border among those it could not compose when no such step is found. Souther reports it as a warning that still fails adequacy, and so does Chisel.

Besides `c.instant()` for an exact moment (`Temporal.Instant`), `c.date()`, `c.time()` and `c.datetime()` hold a calendar date, a time of day and a wall-clock date and time (`Temporal.PlainDate`, `PlainTime` and `PlainDateTime`); a condition orders values of one of these types, and ordering two types against each other does not compile.

Any schema takes `.describe("...")`, as in zod, and a behavior a `description`, saying what they mean to the people reading the specification; neither changes what is parsed or measured, and an optional field carries the description of what it holds. `variants("状態", { 下書き: c.object({...}).describe("まだ申請していない"), ... })` names each case.

A `c.number()` has no value next to a bound, so `price < 1000` owes a row at 1000 but cannot name the one just below it. Where the digits after the point are fixed, as for an amount in cents or a weight in grams, `c.decimal(2)` (or `decimal(3)`) says so. Its values are [decimal.js](https://github.com/MikeMcl/decimal.js) `Decimal`s, so arithmetic on them is exact (`new Decimal("0.1").plus("0.2")` is `0.3`): a value with more digits is refused, a bound steps by one unit of the last digit, so the same guard owes a row at 999.99 too, and `generate` writes the rows as `new Decimal("999.99")`, importing decimal.js beside chisel. A bound written off that grid, such as `$gte(new Decimal("0.004"))` in cents, draws the border of `$gte(new Decimal("0.01"))`. An equality with such a value settles without a row (`$ne(new Decimal("0.005"))` in cents always holds, and `$eq` never does), so it is refused wherever it is written: `implement` refuses it in a guard (`guard in 半端な額 compares $.合計 with 0.005, which no decimal(2) holds: $.合計 != 0.005`), `refine` and its shorthands in an invariant (`refine compares $.合計 with 0.005, …`), and `behavior` in an `ensures` clause (`Ensures 半端にしない compares value.合計 with 0.005, …`). A decimal is compared only with a decimal: two of them draw a border on their difference in units of the finer scale.

The common bounds have zod's shorthands, each desugaring to the same rule `refine` would take: on numbers, decimals and the temporal types `min`, `max`, `gt` and `lt` compare the value (with a bound of the same type, such as `c.date().min(Temporal.PlainDate.from("2026-01-01"))`), and on strings, arrays and records `min`, `max` and `length` compare the length, so the borders keep a value and a length apart. `refine(v => ...)` states anything else, such as a relation between two fields (`.refine(v => v.start.$lte(v.end))`), and takes a name first, as every named construct does (`.refine("starts before it ends", v => v.start.$lte(v.end))`, as do the shorthands, `c.int().min("at least one", 1)`), which the issue for a value breaking it carries as `invariant` (`Invariant starts before it ends violated: $.start <= $.end`) and the borders it draws are labelled with; a value is refused with one issue for every invariant it breaks, and one schema may not name two invariants alike; its callback returns a rule built with term operators, not a boolean, so a condition the analysis cannot read does not type-check. A numeric or decimal term also adds and subtracts, `v.甲.$gte(v.乙.$minus(v.丙))` or `v.甲.$plus(2).$lte(v.乙)`, as Souther conditions do: the comparison reads the value of the expression, and an expression holding a field left out is absent, so the comparison holds. A guard or an input invariant comparing an expression of integer or number fields draws its border on the expression, as Souther does: `甲 >= 乙 − 丙` has its `ON` point at `甲 − 乙 + 丙 = 0` and its `OFF` point at `-1`, and `generate` writes a point by moving a field the expression counts once (a point of `2 * 甲 >= 2 * 乙`, which counts none once, is named among those it could not compose), and the guards on one expression are read together, so a point of `甲 >= 乙 − 丙` behind `甲 <= 乙 − 丙` that no value reaches is owed no row; an expression over decimals is still listed among the comparisons Chisel cannot read.

```ts
const Line = c.object({
  quantity: c.int().min(1),
  unitPrice: c.int().min(0),
});
const Lines = c.array(Line).min(1);
const SubtotalByProduct = c.record(c.int().min(0)).min(1);
```

A record's length is its number of keys, so `SubtotalByProduct` needs at least one product; `generate` writes it as `{ "<key>": 0 }`, one entry showing the shape of its value, the way an array placeholder holds one element.

- **Arms and rules** of an action's `guards`, and the borders and classes its guards draw. A guard compares with the same vocabulary as an invariant: a condition is written on terms, which read a field by its own name, as `run` reads the value (`line.quantity`), and whose operators carry a `$` prefix, so no field name can shadow one: they compare with `$lt`, `$lte`, `$gt`, `$gte`, `$eq` and `$ne`, measure with `$length()`, quantify over array elements with `$all` and `$any`, and combine with `$and`, `$or` and `$not`. A condition becomes a guard with `$else`, which answers when the condition does not hold; that answer is an ordinary result case, so a business rejection is data, not an exception:

```ts
const implementation = c.implement(checkout, {
  cases: {
    withItems: c.action("check stock, then confirm", {
      guards: cart => [
        cart.lines.$all(line => line.quantity.$lte(line.stock)).$else(() => ({
          result: { type: "rejected", reason: "out of stock" },
          effects: [],
        })),
      ],
      run: cart => confirm(cart),
    }),
  },
});
```

  Every guard has a `holds` and an `else` arm, and every case of a `match` is an arm (a `match` that leaves out a case of the `variants` or value of the `enum` it matches on, or names one it does not have, fails to compile, and one on a sum that may be left out, or is held by something that may be, is refused by `implement`, since no case would take its absence: write the absence as a case of the sum); each way through the guards is a rule. Where every value the guards and the `match` read is a boolean, an `enum` or a `variants` case and their combinations are few enough (`feasibility.combinations`), Chisel tries each combination the invariants on those values keep and lists only the ways some combination takes, since the ways `$and`/`$or` spell grow exponentially with the conditions while the combinations stay few; otherwise it lists at most `feasibility.ways` ways (10000 by default, `chisel check --feasibility-ways <n>`) and leaves a decision with more unmeasured instead. A way or an arm no row took is a gap only when some row could take it: where the conditions it passes contradict each other or the invariants of the values they read (`$.x >= 10` holds and `$.x >= 5` fails), no row is owed, and that includes an invariant relating several booleans, enums or `variants` cases by `==`/`!=` (with each other or with a value) and `$and`/`$or`/`$not`, whose combinations Chisel tries up to a limit (`c.check(specification, { feasibility: { combinations } })`, `chisel check --feasibility-combinations <n>`, 4096 by default; past it the way is undecided); where a condition Chisel cannot read (`all`/`any`) shares a value with another, it is undecided, which leaves the verdict `undetermined` rather than `not_satisfied`. Both are counted under their reason instead of listed. A guard border point is settled the same way, from the conditions a row has passed before it reaches the comparison. That holds for a comparison of two positions too, read on their difference: behind a guard `x <= y`, the `IN (> 0)` point of a later `x >= y` is one no row can reach, so no row is owed there, as Souther refutes a point the rules leave no value at. `generate` offers a row for each way no row takes but some row could: where the way ends in a `match`, it moves the matched field of a row that reaches it, and, with `chisel generate --ways` (`c.generate(examples, implementation, { ways: true })`), where every condition on the way compares a boolean, an `enum` or a `variants` case with a value (`==`/`!=`), it writes all of them at once, so a way that needs several values chosen together (`$.甲 == "x"` and `$.乙 == "y"`) gets a row too. Without it such a way is only named, since every way through `$and`/`$or` is its own row and their number grows quickly with the conditions. Wherever a row `generate` writes would break an invariant relating several booleans, enums or `variants` cases, the other values those invariants reach are chosen again so the row keeps them, and a way row is tried from every answered row of the case before its placeholder. A way with an ordering, a length, `all`/`any` or a field inside a `variants` field it cannot compose is named in its output instead. A guard comparing a position with a constant divides it into classes and owes all four border points; one comparing two positions with an order draws its border on their difference, while an equality between two positions draws none, since its `holds` and `else` arms already ask for a row on each side of the line. A guard point is met only by a row that reached the comparison.

A free-form `run` closure may contain branches Chisel cannot read, so its arms are reported as `not measured` and a specification with no gap is `undetermined` rather than `satisfied`. The same holds for a comparison inside `rules` that Chisel cannot draw a line from.

## Postconditions and dependencies

A behavior can state what it ensures of its answer, and declare the outside world it needs:

```ts
const findMember = c.behavior("find-member", {
  input, result, effects,
  requires: { now: c.dependency(c.instant()), lookup: c.dependency(c.string(), c.boolean()) },
  ensures: clause => [
    clause.when("a found member is the one asked for", ["found"], (asked, answer) =>
      asked.id.$gt(0).$and(answer.id.$eq(asked.id)),
    ),
  ],
});
```

Every answer an example writes, the model produces or a conformance subject returns is held to the clauses, and a comparison of the input with a constant draws a border. Clause names must be distinct, and `check` says of every part of every rule how much of it the checker can read (`derivable`, `exact match`, `always holds`, `never holds` or `runtime only`) and which answer cases no clause states anything about. Example rows stand in for value dependencies with `with: { now: ... }` (`generate` writes one on every row it offers, the placeholder of the dependency's type under what the row it moved from writes, so a generated row runs as it is pasted), and a specification stands in for function dependencies with `fakes: [fake(findMember, "lookup", [["m-1", true]], { otherwise: false })]`. An action reads a value dependency in a guard condition through the second argument of its `guards` builder, `action("future only", { guards: (request, deps) => [deps.now.$lt(request.at).$else(...)], run: ... })`: the condition is evaluated against the stand-in a row writes with `with`, and the comparison is measured like any other (here, a border on `deps.now − @case.at`). Function dependencies stay out of conditions. A function dependency can be another behavior, `requires: { stock: dependency(checkStockExamples) }`: a fake table for it is then held to that behavior's `ensures` (a row that breaks one is an error) and to its recorded rows (a row answering differently from one is a warning).

`check` also counts the pairs of classes the rows reach (an observation, never an obligation), over the same classes the report lists (including those guard thresholds draw, and leaving excluded classes out), and `check --json` writes the whole report as one document, described by the closed JSON Schema in [`schema/report.schema.json`](schema/report.schema.json) (published as `chisel/report.schema.json`). Every measure carries `status`, `reason` exactly where it is `unavailable`, and `weakening` exactly where something weakened it; every border point, arm and way carries a stable `obligationId`; `incompleteness` lists the rows that were not observed (not run for want of a stand-in, or not come back); and `sources` names the spec file each report's `source` refers to. `schemaVersion` is raised only when a field is removed or renamed.

## One model, several behaviors

Behaviors that work on one record can share its model as their input: `input: Report` in each of them, so a state added to `Report` reaches every behavior at once. Each of them is then asked about every field of every state, including fields its answer never turns on. `disregards` says which, per input case like `cases`, with `$default` for every case not written; `r => [r]` disregards a whole case:

```ts
export const approve = c.behavior("approve", {
  input: Report,
  result, effects,
  disregards: { submitted: r => [r.lines, r.urgent], $default: r => [r] },
});

c.implement(approve, {
  cases: {
    submitted: c.action("approve within the limit", {
      guards: r => [r.amount.$lte(r.limit).$else(refuse("over the limit"))],
      run: approved,
    }),
    $default: c.action("refuse unless submitted", { run: refuse("not submitted") }),
  },
});
```

A disregarded field draws no classes of its type, no invariant borders and no borders an `ensures` clause draws on it, so `generate` offers no row that only moves it; where a guard or a `match` reads it, it keeps the classes the guard draws or its own classes, since the arms turn on them. Every input case is still owed its row, guards still draw their borders and arms from the whole input, and an invariant that leaves a disregarded field empty is still a model error. Rows keep the whole record, so `c.test` hands production code what it takes. `check` holds the claim: it moves the disregarded fields of an answered row, each element of an array and each entry of a record on its own, through every combination of their other classes and of the invariant border points they would have owed (`IN (> 0)` for an `int().min(0)` at 0), smallest first, runs the model on each and fails the row on the first answer that changes, naming the fields it moved (`approve disregards @submitted.urgent, but its answer changed when @submitted.urgent was true`). A row with more than 255 combinations the input can hold, or more than 4096 candidates before those it cannot hold are left out, is not tried (the limits are the caller's: `c.check(specification, { disregards: { combinations, candidates } })`, or `chisel check --disregard-combinations <n> --disregard-candidates <n>`); it is listed in `incompleteness` as `disregards not checked` and leaves the verdict `undetermined`. `cases.$default` decides every case `cases` leaves out; it is one decision, so its arms and ways are listed once and owed wherever one of its cases can reach them, a `c.todo` there leaves each of its cases pending, and a `$default` beside cases that decide every case is refused. An input case cannot be named `$default`. [`examples/expense-report/`](examples/expense-report/) writes three behaviors over one five-state model both ways.

## Composition

`c.compose(name, [firstImplementation, secondImplementation, ...more])` connects behaviors the way Souther's `>->` does: of the cases a stage answers, those the next stage takes as input flow on to it, and the rest depart the main line and are answered as they are. It takes the stages' implementations and returns the composition's declaration and its implementation together.

```ts
const [quote, quoteImplementation] = c.compose("quote", [validateImplementation, priceImplementation]);
// validate: order -> valid | invalid, price: valid -> quoted
// quote: order -> invalid | quoted

export const quoteSpec = c.spec("quote", {
  examples: c.examples(quote, { /* rows expecting quoted, and invalid */ }),
  implementation: quoteImplementation,
});
```

A stage need not be written yet: `generate` prints an implementation whose every case is `c.todo(...)`, so a composition can be declared and given examples before any stage is implemented. A stage Chisel will never run, one answered by another service, is `c.external(behavior, reason)`: it is not `todo` (nothing is owed), and `check` reports the rows it cannot run (`incompleteness`, printed as rows it could not run) and leaves the verdict `undetermined`; the production code is checked with `c.test` instead.

The composition is an ordinary behavior, so a row may expect a case that departed at an early stage, which no stage's own examples can state. A stage may itself be a composition's implementation. The stages must name their cases by one discriminant; a case that would both depart one stage and be answered by a later one is refused, since a value cannot say which rail it is on. A case that flows on must not carry a field the next stage does not declare, at any depth (`validate answers @valid.total, which price does not declare`), nor a case of a nested sum the next stage does not declare (`@valid.payment@card`); and a field the next stage requires must always be answered (`validate does not always answer @valid.total, which price requires`), so leaving it out or answering it only as optional is refused too. The next stage would refuse such a value the first time the composition runs, so it is refused when composed instead. The same holds for types: every value the first stage may answer must be one the next stage takes, so a leaf of another type (`validate answers @valid.total as number, which price takes as integer`), a container of another kind, a literal of another value, a string where the next stage takes one literal, or an enum where it takes an enum missing one of its values is refused, while an integer where it takes a number, a decimal where it takes a decimal keeping at least as many digits, or a literal where it takes that literal's type, is accepted. Invariants are left to run time: an `int()` answered where the next stage takes `int().min(1)` composes. A literal is the exception, since it has only one value: it is parsed with the next stage's schema, so `literal(0)` answered there is refused. A departed case stays departed through the later stages. Effects and dependencies are united. A composition has no arms or ways of its own, so those measures are `not applicable` for it; its adequacy is measured over its own input and result cases.

## Conformance

`test` runs the human-approved examples against an external controller or service. This keeps model evaluation separate from checking whether infrastructure code conforms to the model. It returns the rows whose answer disagreed and the rows it skipped because their answer is still `todo`, so a test can choose whether an open answer may pass:

```ts
it("the order API answers as the examples say", async () => {
  expect(await c.test(cancelOrderExamples, callOrderApi)).toStrictEqual({
    failures: [],
    skipped: [], // drop this line to let rows still marked todo pass
  });
});
```
