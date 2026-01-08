# リファクタリング準備メモ（フォーク差分棚卸し）

このフォルダは、リファクタリング着手前に「何がどう変わっているか」をファイル単位で棚卸しして、責務・変更点・所見（リファクタ候補）を残すためのメモです。

## 基準点（このメモ作成時点）

- `upstream/main`: `2408811f7e39`（2026-01-05 / `docs(agents): note npm OTP flow`）
- `origin/main`（= 現在の `HEAD`）: `0ad6dfeba1b9`（2026-01-07 / `fix(browser): improve wait defaults and placeholder handling`）
- merge-base（フォーク差分の起点）: `a66ea7353155`

## 対象範囲

- **主差分**: `upstream/main..origin/main`
- **未コミット差分**: working tree（現状 `tsconfig.json` のみ変更あり）
- **補足（未マージブランチ）**: `origin/feat/browser-cleanup-conversation`（`7780af51`）は `origin/main` より古く、未マージのコミットが残っている（取り込みたい場合は `cherry-pick` 推奨）

## 差分抽出コマンド

```bash
git diff --name-status upstream/main..origin/main
git diff --numstat upstream/main..origin/main
git diff upstream/main..origin/main -- <path>
git diff -- tsconfig.json   # 未コミット確認
```

## 重要な前提（今回の差分の性質）

- 変更の中心は **ChatGPT browser automation の安定化**（応答キャプチャの強化、添付アップロードの堅牢化、新規チャット開始、ロケール差分吸収）と、**それを支える CLI/config/docs/test 更新**。
- `upstream/main` は `0.8.4` 相当まで進んでいる一方、`origin/main` は `0.8.2-toarupen.1` を名乗るため、**上流追従（rebase/merge）を行うと衝突が起きやすい**（特に browser cookie 周りや deps/lockfile）。

## この作業で追加したファイル（計画ドキュメント）

- `.Plans/refactoring/00-context.md`
- `.Plans/refactoring/10-changed-files.md`
- `.Plans/refactoring/20-refactor-notes.md`
- `.Plans/refactoring/MASTER_CHECKLIST.md`

## Working tree の未追跡ファイル（ローカル生成物）

このリポジトリの差分棚卸しとは別に、作業ディレクトリ上に未追跡のローカル生成物が存在する（コミット対象外）:

- `.oracle-home/`（Oracle のローカル設定/セッション用）
- `.oracle-browser-profile-foragents-check-*/`（Chrome プロファイル/セッション用）
- `.tmp-cookie-check.mjs`, `.write-test`（一時ファイル）
