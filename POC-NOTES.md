# Issue #28 PoC メモ

Issue #28（複数の behavior が 1 つのレコードのモデルを共有したい）で合意した TO-BE を試し、実際に役立つかを確かめる PoC。
ユーザーが寝ている間に独自に判断したことを、ここに全部書く。

## TO-BE（合意済み）

1. 状態の一覧を共有する：1 つの `const Report = c.variants("status", {...})` を、全 behavior の `input` に使う（新しい API は不要）
2. 読まないフィールドの行を刈る：behavior に `disregards: { <状態>: r => [r.<フィールド>], $default: r => [...] }` を足す
3. 拒否の action のコピーをやめる：`implement` の `cases` に `$default` を足す

## 独自に判断したこと

### ブランチ

- worktree の作成時は `poc/disregards` という名前で切った。元セッションの指示で `poc/issue-28-shared-model` に変更し、`git branch --unset-upstream` で origin/main への upstream を外した。push する場合は `git push -u origin poc/issue-28-shared-model` で新しいリモートブランチに出す（main には push しない）。

### `disregards`

- **内部表現**：`behavior()` を呼んだ時点で term を評価し、状態ごとのキーの列（`Behavior.disregards: Record<tag, string[][]>`）に正規化する。`$default` もこの時点で、書かれていない各状態に展開する。計測する側（`specification.ts`）は、term や `$default` を意識しなくて済む。
- **効く範囲**：`check` の `partitions`（型から作る分割）と、`generate` が出す「型から作る分割の行」と「invariant（`refine` で書くルール）由来の境界の行」の 3 か所だけに効かせた。guard 由来の分割と境界（`guardPartitionsOf` / `guardBordersOf`）は、今までどおり全フィールドから作る。テストで確かめた例：`金額` を disregards にしても、guard `金額 <= 100` の「100 ちょうど」の行（`ON (= 100)`）は出る。
- **パスの一致判定**：刈られるのは、位置（position）の path が `@<状態>.<キー…>` と等しいもの、またはその直後が `.` `[` `?` `@` `{` で続くものだけ。`明細` を指定したとき、名前が `明細` で始まるだけの `明細メモ` は刈られない（テストあり）。キー自体に `.` を含む場合の誤判定は、PoC なので扱っていない。
- **`$default` の型**：`$default` の `r` は、全状態のフィールドを合わせた型にした（`Fielded<Infer<Input>>`）。会話では「書かなかった状態だけのフィールド」に絞る案だったが、それには書いたキーを型引数として推論する仕組みが要るので見送った。その代わり、`$default` が受け持つどの状態にもないフィールドを指したら、実行時に `SpecificationError` を出す（`承認する disregards 至急, which no case $default covers declares`）。
- **型の書き方の落とし穴（Why not のメモ）**：`{ [Tag in Tags]?: ... } & { $default?: ... }` という交差型にすると、`behavior()` の呼び出しの中で `$default` の `r` が `TermOf<never> | TermOf<...>` の union になり、フィールドを指せなかった（型だけを取り出すと正しいのに、呼び出しの文脈で型付けすると壊れる）。`[Key in Tags | "$default"]?` の 1 つの mapped type にしたら直った。
- **`$each` は作っていない**：配列の要素のフィールド（`r.明細.$each.領収書`）を指す手段は足していない。刈れるのは、フィールド全体（`r.明細`）か、配列を通らない入れ子のフィールドまで。
- **`compose`**：合成した behavior は、最初の stage の `disregards` をそのまま引き継ぐ（合成の入力は最初の stage の入力なので）。

### `cases.$default`

- **実装方法**：`implement()` の中で、`$default` を書かれていない各状態に**同じ decision オブジェクト**として展開する。`Implementation.cases` は今までどおり全状態のキーを持つので、`perform`・`traceSync`・guard の境界・`pendingDecisions`・`generate` は変更せずに動いた。
- **arms / ways を 1 回だけ数える方法**：`measureArms` と `measureRules` で、decision をオブジェクトの同一性でまとめる（`decisionsWithCases`）。まだ誰も通っていない way が行を要求するかどうか（feasibility）は、その decision が受け持つ全状態で調べ、1 つでも到達できれば「行が要る（gap）」にする。
- **副作用（既存の挙動の変化）**：`$default` を使わなくても、同じ action の定数を 2 つの状態に手で書いた場合、今までは arms が 2 回数えられていたが、今は 1 回になる。既存のテストはすべて通った。意図に沿う変化と判断して残した。
- **拒否するもの**：`cases` が全状態を書いたうえで `$default` もある場合は `$default of <behavior> decides no case` で拒否する。
- **`$default` の型**：`$default` の action は入力全体（全状態の union）を受け取る。guard の term から指せるのは、全状態に共通するフィールドだけになる（今の `TermOf` の仕様どおり）。
- **やっていないこと**：`match(...)` の cases への `$default`。状態のタグに `$default` という名前が使われた場合の衝突チェック（`variants` 側での拒否）。
