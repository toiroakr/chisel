# 漸進的仕様定義デモ

ホテル予約キャンセルを題材に、スライドと同じ順序で仕様を固めます。

```sh
npm run demo
```

## 1. dataとbehaviorを書く

[stage-01-sketch.spec.ts](./stage-01-sketch.spec.ts)には予約状態、結果、effectとbehaviorの入出力だけがあります。キャンセル処理はまだ実装しません。

```sh
node dist/cli.js generate examples/progressive-demo/stage-01-sketch.spec.ts
```

Chiselは`受付済み`、`予約確定`、`チェックイン済み`、`キャンセル済み`それぞれについて、`expect: unanswered()`のTypeScript exampleを生成します。

## 2. 人間が期待値を埋める

[stage-02-first-answer.spec.ts](./stage-02-first-answer.spec.ts)では、生成された入力に対して人間がresultとeffectsを記入します。

この段階では入力・結果・effectが網羅されていますが、実装はまだ存在しません。

```text
入力variant    4/4
結果variant    2/2
作用variant    2/2
実装             なし
```

## 3. dataとbehaviorを更新する

仕様を話し合う中で、`予約確定`の返金可否は宿泊開始日時とキャンセル要求日時から決まると分かります。[stage-03-refined.spec.ts](./stage-03-refined.spec.ts)では、`予約確定`に`instant()`で定義した次の情報を追加します。

```text
宿泊開始日時
キャンセル要求日時
```

日時を持たない古い`状態: "予約確定"`のexampleはコンパイルできません。

```sh
npm run demo:type-break
```

`generate`をもう一度実行すると、追加した日時フィールドを含む`予約確定`の未回答exampleが生成されます。

```sh
node dist/cli.js generate examples/progressive-demo/stage-03-refined.spec.ts
```

## 4. exampleを満たすmodelを実装する

[stage-04-complete.spec.ts](./stage-04-complete.spec.ts)では、生成された雛形を期限前・期限ちょうど・期限後の3例へ展開します。キャンセル要求が宿泊開始の24時間前までなら返金し、それより後なら返金しない仕様です。

返金可否は保存済みの状態ではなく、2つの`Temporal.Instant`からmodelが計算します。実行時に時計を直接読む代わりにキャンセル要求日時を入力へ含めるため、exampleは実行時刻に依存しません。

Chiselはmodelをすべてのexampleに対して実行します。一致すると次の状態になります。

```text
入力variant    4/4
結果variant    2/2
作用variant    2/2
実装             あり
充足度           未確定 (undetermined)
```

`未確定`は、宣言されたvariantとeffectの範囲には穴が見つからなかったものの、decision内部に自由記述したTypeScriptの分岐をChiselが読めないため、分岐まで網羅できたかは判定できないという意味です。穴が見つかったときの`不完全`とは区別されます。
