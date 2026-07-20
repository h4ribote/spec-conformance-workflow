# conformance.json のスタック別初期値

そのまま採用せず、**必ずプロジェクトで実際に走らせて確認してから** `.claude/conformance.json` に書くこと。誤ったテストコマンドは以降の全バッチの検証を静かに無効化する。`{file}` は個別テストファイル名に置換されるプレースホルダである。

## Python (pytest)

```json
{
  "testCommand": "python -m pytest tests/{file}.py",
  "fullSuiteCommand": "python -m pytest -n auto",
  "hygieneRoots": ["src", "tests", "doc"]
}
```

`-n auto` は `pytest-xdist` が入っている場合のみ。個別ファイルの実行に `-n auto` を付けるとワーカー起動コストが実行時間を上回るので、`testCommand` 側には付けない。パッケージが未インストールのリポジトリでは `PYTHONPATH` の指定が要ることがある（`pytest` が通ることと CLI が起動することは別問題なので、両方確認する）。

## Node / TypeScript (jest, vitest)

```json
{
  "testCommand": "npx jest {file}",
  "fullSuiteCommand": "npx jest --maxWorkers=50%",
  "hygieneRoots": ["src", "test", "docs"]
}
```

vitest なら `npx vitest run {file}` / `npx vitest run`。モノレポではワークスペースのフィルタ（`pnpm -F pkg test`）まで含めて書く。

## Go

```json
{
  "testCommand": "go test ./{file}/...",
  "fullSuiteCommand": "go test ./...",
  "invariantChecks": ["go vet ./...", "go test -race ./..."],
  "hygieneRoots": ["cmd", "internal", "pkg", "docs"]
}
```

`-race` は重いので `invariantChecks` か `heavyTests` へ回し、通常のフルスイートからは外す。

## Rust

```json
{
  "testCommand": "cargo test --test {file}",
  "fullSuiteCommand": "cargo test --all",
  "invariantChecks": ["cargo clippy --all-targets -- -D warnings"],
  "hygieneRoots": ["src", "tests", "docs"]
}
```

## invariantChecks の作り方

`coreContracts` の各項目に対して、緑・赤が自動で決まるコマンドを1本ずつ用意する。既存のテストで代用できるならそれを名指しし、無ければ作る。よくある形:

- **再現性**: 同一シードで2回実行し、最終状態のハッシュが一致することを確認するハーネス
- **永続形式の後方互換**: リポジトリに固定した旧バージョンの保存データを読み込み、成功することを確認する
- **ドメイン不変条件**: 長時間実行の後に恒等式（合計の保存、非負性など）を検証する
- **認可境界**: 権限の無い主体からのアクセスが全経路で拒否されることを確認する統合テスト
- **性能予算**: 代表操作のベンチマークを閾値付きで実行する

`invariantChecks` が空のままフェーズを進める場合、中核契約の回帰は誰も捕まえられない。その状態で作業を続けるかどうかはユーザーに明示して判断を仰ぐこと。
