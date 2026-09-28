# Issue #28 PoC メモ

Issue #28（複数の behavior が 1 つのレコードのモデルを共有したい）で合意した TO-BE を試し、実際に役立つかを確かめる PoC。
ユーザーが寝ている間に独自に判断したことを、ここに全部書く。

## TO-BE（合意済み）

1. 状態の一覧を共有する：1 つの `const Report = c.variants("status", {...})` を、全 behavior の `input` に使う（新しい API は不要）
2. 読まないフィールドの行を刈る：behavior に `disregards: { <状態>: r => [r.<フィールド>], $default: r => [...] }` を足す
3. 拒否の action のコピーをやめる：`implement` の `cases` に `$default` を足す

## 独自に判断したこと

### ブランチ

- worktree の作成時は `poc/disregards` という名前で切った。元セッションの指示で `poc/issue-28-shared-model` に変更し、`git branch --unset-upstream` で origin/main への upstream を外した。
- `git push -u origin poc/issue-28-shared-model` で新しいリモートブランチに push した。main には push していない。PR は作っていない。
- コミット：`f290d14`（disregards）→ `44316cf`（cases.$default）→ `64192ce`（check での確認、例、このメモ）→ そのあとに、advisor の指摘を受けた修正のコミット。

### `disregards`

- **内部表現**：`behavior()` を呼んだ時点で term を評価し、状態ごとのキーの列（`Behavior.disregards: Record<tag, string[][]>`）に正規化する。`$default` もこの時点で、書かれていない各状態に展開する。計測する側（`specification.ts`）は、term や `$default` を意識しなくて済む。
- **効く範囲**：`check` の `partitions`（型から作る分割）と、`generate` が出す「型から作る分割の行」と「invariant（`refine` で書くルール）由来の境界の行」の 3 か所だけに効かせた。guard 由来の分割と境界（`guardPartitionsOf` / `guardBordersOf`）は、今までどおり全フィールドから作る。テストで確かめた例：`金額` を disregards にしても、guard `金額 <= 100` の「100 ちょうど」の行（`ON (= 100)`）は出る。
- **パスの一致判定**：位置（position）に、表示用の path 文字列とは別に、区切りごとの配列 `segments`（例：`["@下書き", ".明細", "[]", ".領収書"]`）を持たせ、配列の先頭が一致するかで判定する。`明細` を指定しても、名前が `明細` で始まるだけの `明細メモ` は刈られない。キーに `.` を含む `"注文.メモ"` を指定しても、入れ子のフィールド `注文` → `メモ` は刈られない（どちらもテストあり）。最初は path 文字列の前方一致で判定していたが、キーに `.` を含むとき、表示が同じになる入れ子のフィールドまで刈ってしまうので、配列に変えた（セルフレビューでの指摘）。
- **`$default` の型**：`$default` の `r` は、全状態のフィールドを合わせた型にした（`Fielded<Infer<Input>>`）。会話では「書かなかった状態だけのフィールド」に絞る案だったが、それには書いたキーを型引数として推論する仕組みが要るので見送った。その代わり、`$default` が受け持つどの状態にもないフィールドを指したら、実行時に `SpecificationError` を出す（`承認する disregards 至急, which no case $default covers declares`）。
- **型の書き方の落とし穴（Why not のメモ）**：`{ [Tag in Tags]?: ... } & { $default?: ... }` という交差型にすると、`behavior()` の呼び出しの中で `$default` の `r` が `TermOf<never> | TermOf<...>` の union になり、フィールドを指せなかった（型だけを取り出すと正しいのに、呼び出しの文脈で型付けすると壊れる）。`[Key in Tags | "$default"]?` の 1 つの mapped type にしたら直った。
- **`$each` は作っていない**：配列の要素のフィールド（`r.明細.$each.領収書`）を指す手段は足していない。刈れるのは、フィールド全体（`r.明細`）か、配列を通らない入れ子のフィールドまで。
- **`compose`**：合成した behavior は、最初の stage の `disregards` をそのまま引き継ぐ（合成の入力は最初の stage の入力なので）。
- **`Behavior.disregards` は省略不可のフィールドにした**：`behavior()` が必ず `{}` 以上を入れる。計測する側が `undefined` を気にしなくて済むようにするため。その代わり、`Behavior` を自分で組み立てる `composition.ts` にも足す必要があった（`dependency.ts` の `kind: "behavior"` は型の判定で、組み立てではないので触っていない）。
- **guard が分割する位置は、disregards に書いても刈らない**：`check` の partitions は、guard が引いた分割（`金額 <= 100` のしきい値で分けたクラスなど）を位置に対応付けて数えている。そのため、位置ごと刈ると guard の分割まで report から消え、一方で `generate` は guard の分割の行を出す、という食い違いになっていた。guard が読むフィールドは答えに関係するので、guard が分割する位置は `check` でも `generate` でも刈らないことにした（CodeRabbit の指摘。テストあり）。
- **invariant の矛盾（`modelIssues`）は刈らない**：最初は `check` の `positions` をまとめて刈った位置に差し替えたので、刈ったフィールドの invariant が矛盾していても（`int().min(10).max(5)` など）、`modelIssues` から消えていた。モデルの矛盾は behavior がそのフィールドを見るかどうかと関係ない事実なので、`modelIssues` だけは全フィールドから作るように直した（advisor の指摘。テストあり）。

### `cases.$default`

- **実装方法**：`implement()` の中で、`$default` を書かれていない各状態に**同じ decision オブジェクト**として展開する。`Implementation.cases` は今までどおり全状態のキーを持つので、`perform`・`traceSync`・guard の境界・`pendingDecisions`・`generate` は変更せずに動いた。
- **arms / ways を 1 回だけ数える方法**：`measureArms` と `measureRules` で、decision をオブジェクトの同一性でまとめる（`decisionsWithCases`）。まだ誰も通っていない way が行を要求するかどうか（feasibility）は、その decision が受け持つ全状態で調べ、1 つでも到達できれば「行が要る（gap）」にする。
- **副作用（既存の挙動の変化）**：`$default` を使わなくても、同じ action の定数を 2 つの状態に手で書いた場合、今までは arms が 2 回数えられていたが、今は 1 回になる。既存のテストはすべて通った。意図に沿う変化と判断して残した。
- **拒否するもの**：`cases` が全状態を書いたうえで `$default` もある場合は `$default of <behavior> decides no case` で拒否する。
- **`$default` の型**：`$default` の action は入力全体（全状態の union）を受け取る。guard の term から指せるのは、全状態に共通するフィールドだけになる（今の `TermOf` の仕様どおり）。
- **`$default` という名前の状態は拒否する**：入力に `$default` というタグがあると、`cases` にも `disregards` にも `$default` という名前のキーが 2 つの意味で現れて区別できない。`variants` 側で拒否すると、behavior の入力以外（result、effects、sum フィールド）でも使えなくなるので、`behavior()` で入力に限って拒否した（`<behavior> cannot take a case named $default`。セルフレビューでの指摘）。
- **やっていないこと**：`match(...)` の cases への `$default`。

### 状態ごと丸ごと刈る `r => [r]`

- 例を作っている途中で、「条件なしで拒否するだけの状態では、どのフィールドも答えに関係ない」と気づいた。フィールドを 1 つずつ並べると、`submit` の `$default: r => [r.lines]` で `@submitted.urgent` を刈り忘れた（実際にやってしまった）。
- `disregards: { $default: r => [r] }`（term の根＝状態そのもの）と書けば、その状態のフィールドを全部刈れる。今の実装のまま動いたので、新しい仕組みは足さず、テストだけ追加した（`offers only the case's own row when the case itself is disregarded`）。
- `cases.$default` で拒否する状態と `disregards.$default: r => [r]` が対になるので、実際の書き味はこの組み合わせが中心になりそう。

### `check` での確認（disregards が正しいか）

- 答え済みの行で、実装の答えが期待どおりだったとき、disregards にしたフィールドのうち値の種類で分かれるもの（boolean、省略可能、sum）について、行の値をほかの種類に差し替えて実装を走らせ直す。答えが変わるか、エラーになったら、`failures` に `<behavior> disregards <path>, but its answer changed when it was <class>` を追加する。
- 新しい report の項目を作らず、既存の `failures` に載せた理由：`adequate` が自然に false になり、`check --json` の閉じた schema（`schema/report.schema.json`）も変えずに済むため。
- **修正した不具合**：確認の対象を「行の状態の下にある位置」に絞る判定を、最初は前方一致（`startsWith("@下書き")`）で書いていた。そのため、状態 `下書き` の行に対して `@下書き2.…` の位置まで選んでしまい、行を `下書き2` の状態に書き換えて走らせ、答えが変わったと誤って報告していた。`disregards` の判定と同じ、区切りごとの配列の一致（`isUnder`）に揃えた（advisor の指摘。テストあり）。
- 確かめるのは値の種類で分かれる位置だけで、`int().min(0)` のような invariant の境界点（0 ちょうど、など）への差し替えはしていない。
- 経費精算の例の `approve` に答え済みの行を 6 行足して `check` したところ、誤検知は 0 件だった。

## 結果（経費精算の例：`examples/expense-report/`）

- **引き継ぎの指示から変えた点**：
  - 領収書 `receipt` は、指示では省略可能な string だったが、`c.boolean()`（領収書が付いているか）に変えた。Chisel では「比べる相手が省略されているとき、比較は成り立つ」ので、`submit` の guard を `line.receipt.$ne("")` と書くと、領収書のない宿泊の明細でも guard が成り立ってしまい、「宿泊には領収書が要る」を表せなかったため。型エラーが出たからではない。
  - 指示にない `amount: int().min(0)`（明細の金額）と `urgent: c.boolean()`（submitted だけの至急フラグ）を足した。前者は invariant の境界の行（`IN (> 0)`）がどう刈られるかを、後者は「その状態にしかないフィールド」が `$default` でどう扱われるかを見るため。
- モデル：`model.ts` に 5 状態（draft / submitted / approved / returned / settled）の `Report`。明細 `lines[]` は、費目 `category`（LODGING / TRANSPORT / MEAL）、金額 `amount: int().min(0)`、領収書の有無 `receipt: boolean()` を持つ。submitted だけが至急フラグ `urgent: boolean()` を持つ。
- behavior は 3 つ。全部 `input: Report` を共有する。
  - `submit`：draft で、宿泊の明細すべてに領収書があれば提出、それ以外は拒否
  - `approve`：submitted で、金額が上限以内なら承認
  - `settle`：approved なら精算
- `before.spec.ts`：今の Chisel の書き方。`disregards` も `$default` も使わず、拒否の action を状態ごとにコピーする
- `after.spec.ts`：`disregards` と `cases.$default` を使う

### `chisel generate` の行数（答え済みの行が 0 のとき）

| behavior | before | after | after で残った行 |
|---|---|---|---|
| submit | 22 | 9 | 状態ごと 5 行 ＋ draft の明細（費目 2・領収書 1・金額 1）4 行 |
| approve | 22 | 5 | 状態ごと 5 行 |
| settle | 22 | 5 | 状態ごと 5 行 |
| 合計 | 66 | 19 | |

- before で消えた行は、すべて「その behavior の答えが変わらないフィールド」を動かしたものだった。例：`approve: @draft.lines[].category = TRANSPORT`、`approve: @returned.lines[].receipt = true`、`settle: @submitted.urgent = true`。
- after に残った `submit` の明細の行（`@draft.lines[].category = TRANSPORT` など）は、`submit` の guard（宿泊には領収書が要る）が実際に読む問いなので、残って正しい。

### 状態 `rejected`（lines と、省略可能な note を持つ）を足したとき

- before：`implement` 3 か所がすべてコンパイルエラー（`rejected` の case がない）。ただしエラーメッセージは型の中身がずらずら並ぶ長いもので、「`rejected` がない」とすぐには読み取れない。
- after：コンパイルエラーは出ない。`generate` が `approve: rejected`・`settle: rejected`・`submit: rejected` の 3 行を出し、答えを人に聞く。`rejected` の `lines` / `note` の行は `$default: r => [r]` で刈られる。
- トレードオフ（会話で確認済み）：`$default` があると、新しい状態はコンパイルエラーではなく「答えが todo の行」で知らされる。気づく手段はあるが、コンパイルエラーより弱い。

## 有用だったか（所感）

- **有用だった**：Issue の摩擦 2（読まないフィールドの行）は、この例で 66 行 → 19 行になり、残った行はすべて意味のある問いだった。摩擦 3（拒否のコピー）は、各 behavior で 4 つのコピーが `$default` 1 つになった。
- **`disregards` と `cases.$default` はほぼ必ずセットで使う**：拒否するだけの状態では `cases.$default` と `disregards.$default: r => [r]` を両方書くことになる。「`cases.$default` で決める状態は、自動的に全フィールドを disregard する」という既定も考えられるが、`$default` の action が guard を持つ場合もある（テストでは ID で分けた）ので、PoC では自動にしなかった。要検討。
- **摩擦 1（状態一覧の重複）は、確かに新しい API なしで解けた**：`Report` を 1 つ共有するだけで済んだ。

## 未解決・やっていないこと

- `$each`（配列要素のフィールドだけを刈る）
- `$default` の `r` の型を「書かなかった状態のフィールド」に絞ること
- 刈ったフィールドを `check` の report に出すこと（今は report から見えない。`check` での確認の失敗だけが見える）
- `match(...)` の `$default`
- 既存の問題（PoC とは無関係）：`approve` の guard `amount <= limit` の境界（2 つの位置の差）の行は、答え済みの行が 0 のとき `generate` から before / after のどちらでも出なかった。答え済みの行を足すと `check` では ON / OFF / IN / OUT が出る。
