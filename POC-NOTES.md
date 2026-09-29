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
- **guard が分割する位置は、disregards に書いても刈らない**：`check` の partitions は、guard が引いた分割（`金額 <= 100` のしきい値で分けたクラスなど）を位置に対応付けて数えている。そのため、位置ごと刈ると guard の分割まで report から消え、一方で `generate` は guard の分割の行を出す、という食い違いになっていた。guard が読むフィールドは答えに関係するので、guard が分割する位置は `check` でも `generate` でも刈らないことにした（CodeRabbit の指摘。テストあり）。ただし残すのは guard の分割だけで、その位置の型由来の種類と invariant の境界（`int().min(0)` の「0 ちょうど」など）は刈ったままにする。最初は位置ごと残したので、それらの行まで戻っていた（Copilot の指摘。テストあり）。
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

- 答え済みの行で、実装の答えが期待どおりだったとき、disregards にしたフィールドのうち値の種類で分かれるもの（boolean、省略可能、sum）について、ほかの種類への差し替えを**全組み合わせで**試し、実装を走らせ直す。動かすフィールドの数が少ない組み合わせから試し、最初に答えが変わるかエラーになった組み合わせを、1 行につき 1 件 `failures` に載せる（`<behavior> disregards <path>, <path>, but its answer changed when <path> was <class> and <path> was <class>`）。
- **1 つずつではなく全組み合わせにした理由**：最初は 1 フィールドずつ差し替えていたが、「2 つの boolean が両方 `true` のときだけ保留」のような実装を見逃す（CodeRabbit の指摘）。ユーザーの判断で、3 つ以上の組み合わせでも見逃さない方針にした。種類の単位では全組み合わせを試すので、見逃しはない。
- **作れない組み合わせは試さない**：sum フィールドを「現金」にしつつ「カード」の下のフィールドを動かす、のような組み合わせは、`place` で別の位置が書き換わってしまう。差し替えたあとに、各位置が選んだ種類のまま（動かさない位置は元の種類のまま）になっているかを確かめ、なっていなければ飛ばす（テストあり）。
- **上限 255 通り**：組み合わせは「(各位置のほかの種類の数 + 1) の積 − 1」通りで、boolean 8 個で 255 通り、9 個で 511 通りと指数的に増える。255 通りを超える行は走らせず（数えるのは入力として作れる組み合わせだけ。最初は作れないものも含めた単純な積で数えていたので、省略可能な boolean 4 つで 1295 通りと数え、実際は 80 通りなのに確かめていなかった。Copilot の指摘。作れるかどうかを調べる前の候補数にも、Souther の判断グループの上限にならって 4096 通りの上限を置き、超えたら数えずに `disregards not checked` にする）、`incompleteness` に `disregards not checked` として載せ、verdict を `undetermined` にする。黙って通すことはしない。上限の値（255）は、boolean 8 個までは全部試せる、という目安で決めた。`check --json` の schema の `incompleteness.kind` にもこの種類を足し、CLI では「実行できなかった行」とは別に「disregardsを確かめていない行」と表示する。
- 答えが変わった行を、新しい report の項目を作らず既存の `failures` に載せた理由：`adequate` が自然に false になるため。一方、組み合わせが上限を超えて確かめなかった行は、失敗ではないので `incompleteness` に新しい種類 `disregards not checked` として載せた。こちらは `check --json` の閉じた schema（`schema/report.schema.json`）の `incompleteness.kind` にも足している。
- 差し替えた入力で実装が例外を投げたときは、「答えが変わった」ではなく `... but it threw when <path> was <class>: <エラーの文>` と報告する。最初はどちらも「答えが変わった」と書いていたので、実装のエラーと別の答えの区別がつかなかった（Copilot の指摘。テストあり）。
- **guard が読む位置の種類は残す**：guard の条件（`$all` / `$any` の中も含む）と `match` が読むフィールドを集め（`guardReadSegmentsOf`）、disregards に書いてあっても、その位置の種類（boolean の `true` / `false` など）は残し、invariant の境界だけを刈る。`guardPartitionsOf` は数値のような順序のある型にしか分割を作らないので、最初は guard が読む boolean の種類まで刈っていて、`generate` がもう一方の分岐の行を出せなかった（Copilot の指摘。テストあり）。`deps.許可.$any(value => r.至急.$eq(value))` のように value dependency の上で回す `$all` / `$any` も中の条件まで辿り、要素（`value`）だけを入力でないものとして扱う（最初は中の条件ごと読み飛ばしていた。Copilot の指摘。テストあり）。guard が読む path の先頭部分にあたる位置（`詳細.至急` を読むときの省略可能な `詳細` の なし / あり、`category.type` を読むときの sum フィールド `category` の case）も「guard が読む位置」として種類を残す。最初は path が完全に一致する位置だけにしていた（Copilot の指摘。テストあり）。
- **修正した不具合**：確認の対象を「行の状態の下にある位置」に絞る判定を、最初は前方一致（`startsWith("@下書き")`）で書いていた。そのため、状態 `下書き` の行に対して `@下書き2.…` の位置まで選んでしまい、行を `下書き2` の状態に書き換えて走らせ、答えが変わったと誤って報告していた。`disregards` の判定と同じ、区切りごとの配列の一致（`isUnder`）に揃えた（advisor の指摘。テストあり）。
- **invariant の境界点も動かす**：disregards は型由来の分割だけでなく invariant の境界点の行（`int().min(0)` の「0 ちょうど（ON）」「0 より大きい（IN）」）も刈る。最初は値の種類で分かれる位置しか差し替えていなかったので、刈った境界点の分は確かめていなかった（Copilot の指摘）。境界点のうち、行がまだ満たしていない owed の点を、その点の代表値（witness）に書き換える動きとして組み合わせに加えた。失敗の文は `... when @提出済み.金額 was IN (> 0)` のようになる（テストあり）。
- **省略可能な object の中・入れ子の sum の中も指せる**：term は `r.詳細.至急` のように、省略可能（`?`）や入れ子の case（`@カード`）を名指ししないで中へ入る。位置の区切りの配列からこれらの印を除いてから比べるようにした。最初は除いていなかったので、`r.詳細.至急` を書いても刈られなかった（Copilot の指摘。テストあり）。
- **`toString` のような名前の状態**：状態名で `disregards` と `cases` を引くとき、自分のキーかどうか（`Object.hasOwn`）を確かめるようにした。確かめないと、`Object.prototype.toString` を builder だと思って呼び、`behavior()` が落ちていた（Copilot の指摘。テストあり）。同じ理由で、共有の `schemaAtPath`（フィールドの schema を key の列で引く関数）も `Object.hasOwn` で引くようにした。これがないと、`$default` が受け持つ状態に `toString` というフィールドがなくても、継承した `Object.prototype.toString` を「ある」と見なし、何も刈らない指定が黙って通っていた（Copilot の指摘。テストあり）。ただし型の上では、`toString` という名前の状態があると、`disregards: { $default: ... }` のオブジェクトリテラルが継承する `toString` と `disregards` の `toString` キーの型がぶつかり、コンパイルが通らない。TypeScript の仕様で、型だけで避ける手段が見当たらなかったので、制約として残した。
- **guard が分割する位置も `check` で確かめる**：型由来の種類と invariant の境界を刈った位置は、guard が分割していても、刈った分を差し替えて確かめる。最初は guard が分割する位置を確認から丸ごと外していたので、刈った分（`int().min(0)` の「0 より大きい」など）が確かめられていなかった（Copilot の指摘。テストあり）。guard が読むフィールドの値を動かして答えが変われば失敗になるが、それは「このフィールドは答えに関係ない」という disregards の主張が本当に崩れているので、正しい報告として扱う。
- **入れ子の sum の中のフィールドも `$default` で指せる**：`$default: r => [r.支払.参照番号]` のように、入れ子の `variants` の case にあるフィールドを指したとき、「受け持つ状態にあるか」の確認が `schemaAtPath`（sum の手前で止まる）を使っていたため、「ない」と判断して `behavior()` が落ちていた。確認用に、入れ子の sum のどれかの case にあれば「ある」とする `reachesPath` を足した。`schemaAtPath` は `match` の検査が sum の手前で止まることを前提にしているので変えていない（Copilot の指摘。テストあり）。
- **disregards にないフィールドを動かす組み合わせは試さない**：`詳細.至急` だけを disregards に書き、省略可能な親 `詳細` は書いていない場合、`詳細` のない行で `至急` を差し替えると `place` が `詳細` まで作ってしまう。そのため、「`詳細` があるかどうか」で答えが変わる正しい実装を、誤って失敗と報告していた。差し替えたあと、disregards に書いていない位置の種類と境界の値が元のままかを確かめ、変わってしまう組み合わせは試さないようにした（Copilot の指摘。テストあり）。
- **配列の要素・record のエントリを 1 つずつ差し替える（解決済み）**：ユーザーの判断（案 A）で、`src/partition.ts` の位置の組み立て（`Focus`）を、親の値から子の値へ降りる手順（`Step`）の合成に書き直し、行の中にある要素・エントリの一つ一つを返す `instancesIn(given)` を位置に足した。`check` の確認はこの一つ一つを別の軸として差し替え、失敗の文は `@提出済み.明細[1].至急`、`@提出済み.担当{"甲"}` のようにどの要素かを示す。空の配列・record では、これまでどおり要素・エントリを 1 つ作って確かめる。`generate` と `check` の分割・境界の計算は今までどおり（最初の要素・全エントリ）で、既存のテストはすべてそのまま通った。動かす数が同じ組み合わせは、先に宣言された位置を動かすものから試す（テストあり）。以下は当初の記録。
- **（当初の記録）配列の 2 つ目以降の要素**：`place` / `write` は配列の最初の要素しか書き換えず、`classify` はどれか 1 つの要素がその種類なら「その種類」と見なす。そのため、明細が 2 件以上ある行では、2 件目以降の disregard したフィールドで答えが変わる実装を見逃す（Copilot の指摘）。record の値は逆に全エントリをまとめて書き換えるので、1 つのエントリだけが違うときに答えが変わる実装を見逃す（同じく Copilot の指摘）。直すには `src/partition.ts` の位置の組み立て（`Focus`）を要素ごとに書き換えられる形に変える必要があり、影響が大きいので、方針を決めてから対応する。選択肢は、(1) 要素ごとに差し替える、(2) 要素が 2 件以上ある行は `disregards not checked` にして確かめない（`undetermined` になる）、(3) 制約として残す。
- **`match` が読むフィールドは path 全体で記録する**：`guardReadSegmentsOf` は `match` の対象から最後のキーを落として記録していた。sum フィールド（`r.支払.方法` → `支払`）ならそれで正しいが、#30 の `c.enum` のようにフィールドそのもの（`r.費目`）で分ける `match` では `費目` が消え、disregards に書くと種類ごと刈られて、`check` は分岐の gap を報告するのに `generate` が行を出さなくなる（#29 と #30 を組み合わせて確かめたサブエージェントの報告）。照合は「位置の path が読む path の先頭部分なら読んでいる」という前方一致なので、path 全体を記録すれば sum（`支払` は `支払.方法` の先頭）も enum（`費目` そのもの）も一致する。#30 がなくても今のうちに直せるので、この PR で直した（sum の回帰テストあり）。
- **#30（enum）・#31（decimal）との組み合わせ確認**：それぞれ #29 とマージした状態で型検査とテスト 524 件が通った。decimal の境界点（`min(0)` の 0.01 など）への差し替え、enum の値の差し替え、配列要素の enum / decimal も正しく確かめられた。テキストの衝突は #30 との `CLAUDE.md` の段落だけ。
- **動かした位置が消した子孫は「動いていない」と数える**（Copilot の指摘）：組み合わせを試すとき、動かさない位置は元の区分・座標のままであることを求めていた。そのため `詳細`（optional の object）を なし にすると、中の `詳細.至急` が false から「値なし」に変わり、組み合わせごと捨てられていた。`詳細` がないときだけ答えを変える実装が見逃されていた。sum フィールドを別の case にしたとき、配列を短くしたときも同じ。動かさない位置が変わった先で区分も座標も読めなくなっている（＝その値がもう存在しない）ときは、動いていないものとして扱うようにした。
- **guard の分析も区切りの配列で位置を照合する（解決済み）**：「guard が分割する位置は刈らない」の判定や、guard の分割・境界を位置に対応付ける処理が、表示用の path 文字列で位置を照合していた。そのため、キーに `.` を含む `"注文.メモ"` と入れ子の `注文` → `メモ` が同じ状態にあると取り違えていた（Copilot の指摘）。ユーザーの判断でこの PR で直した。`src/guard-borders.ts` の `Frame`・`Threshold`・`GuardPartition`・`GuardBorder` に区切りの配列（`segments`）を持たせ、位置の検索（`at`）と、`check` / `generate` での guard の分割・境界と位置の対応付けを、この配列で行うようにした。表示用の path 文字列（report の `path`、行の名前）は今までどおり（テストあり）。
- **Souther との比較（組み合わせ爆発）**：Souther（`souther-lang/souther`）は、全組み合わせではなく 2 つの位置のクラスの組（pairwise）と、本体の中で 1 つの値に合流する判断同士の組み合わせだけを数える。どちらにも組み合わせ総数の上限（2 クラスの組 20,000、判断グループ 4,096）があり、超えたときは件数を減らしたり 2 因子に落としたりして測らず、「測れなかった」として `undetermined` にする。上限をこの PR の `DISREGARD_COMBINATION_LIMIT` のようなモジュール内の定数にせず、全体のポリシーとして外から渡すのが Souther の方針（ADR-0113）。一方、「値を動かしても答えが変わらないか」を実行して確かめる機能は Souther にはない。Chisel の disregards の確認は Souther にない独自の検査で、上限を超えたら `undetermined` にする点は Souther の立場と同じ。ユーザーの判断で、上限は `check(specification, { disregards: { combinations, candidates } })` と CLI の `--disregard-combinations` / `--disregard-candidates` で外から渡せるようにした（既定は 255 と 4096。テストあり）。
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
