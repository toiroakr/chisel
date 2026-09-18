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

仕様を話し合う中で、`予約確定`はキャンセル期限の前後で扱いが異なると分かります。[stage-03-refined.spec.ts](./stage-03-refined.spec.ts)では次の2状態へ分割します。

```text
返金可能な予約 | 返金不可な予約
```

古い`状態: "予約確定"`のexampleはコンパイルできません。

```sh
npm run demo:type-break
```

`generate`をもう一度実行すると、`返金不可な予約`の未回答exampleだけが生成されます。

```sh
node dist/cli.js generate examples/progressive-demo/stage-03-refined.spec.ts
```

## 4. exampleを満たすmodelを実装する

[stage-04-complete.spec.ts](./stage-04-complete.spec.ts)で期限後の期待値を決め、`implement()`で実行可能モデルとcontrol policyを書きます。

Chiselはmodelをすべてのexampleに対して実行します。一致すると次の状態になります。

```text
入力variant    5/5
結果variant    2/2
作用variant    2/2
実装             あり
充足度           完全
```

このデモにおける`完全`は、宣言されたvariantとeffectの範囲が満たされたという意味です。decision内部に自由記述したTypeScriptの分岐まで完全だとは主張しません。
