# リファクタ計画：マスターチェックリスト

このチェックリストは、`.Plans/refactoring/` 配下の計画ドキュメントを「一望」できるように、判断ポイントと実行順をチェック形式でまとめたものです。

参照:
- `.Plans/refactoring/00-context.md`
- `.Plans/refactoring/10-changed-files.md`
- `.Plans/refactoring/20-refactor-notes.md`

---

## 0) ゴール/スコープ確定

- [ ] リファクタの目的を1文で定義（例: browser automation の保守性向上、巨大ファイル分割、重複排除）
- [ ] 「リファクタで変えないこと」を明記（挙動/CLI互換/セッション互換など）
- [ ] 対象ブランチ/基準点を固定（`upstream/main` / `origin/main` / merge-base）
- [ ] 変更を小さく刻む方針（PR/コミット単位）を決める

## 1) 現状棚卸し（インベントリ）

- [ ] `00-context.md` を更新（基準点が変わった場合のみ）
- [ ] `10-changed-files.md` に漏れがないか確認（追加で変えたファイルがあれば追記）
- [ ] 未追跡のローカル生成物が `git status` に出ないことを確認（`.gitignore` 反映済みか）
- [ ] “未コミット変更” をゼロにするか（または意図/理由を残す）を決める（現状: `tsconfig.json`）

## 2) 先に決めるべき判断ポイント（衝突/方針）

- [ ] upstream 追従方針（merge/rebase/cherry-pick、どのタイミングで合わせるか）
- [ ] `cookieSyncWaitMs`（廃止/再導入/別案）の方針
- [ ] ロケール方針（英語固定へ戻す vs 多言語前提のまま整備）
- [ ] `cleanupConversation` の位置付け（fork-only / upstream 提案 / 安全設計の維持）

## 3) リファクタ対象の優先順位（候補から選定）

優先度は `.Plans/refactoring/20-refactor-notes.md` を基準に選ぶ。

- [ ] P0: `src/browser/actions/assistantResponse.ts`（責務分割の設計を決める）
- [ ] P0: `src/browser/actions/attachments.ts`（巨大 evaluate とシグナル判定の分割方針を決める）
- [ ] P1: `src/browser/actions/promptComposer.ts`（composer scope 探索の共通化）
- [ ] P1: `src/browser/index.ts` と `src/browser/reattach.ts`（重複フローの共通化）
- [ ] P2: 周辺の小改善（formatDuration の再利用、tmp cleanup、docs/CLI/help の同期など）

## 4) 設計（分割単位と公開API）

### `assistantResponse.ts`
- [ ] 現在の公開関数/テスト用 export を列挙（移動後も互換維持するか決める）
- [ ] 分割モジュール案を確定（例: `placeholders`, `watchdog`, `extract`, `htmlToMarkdown`, `debug`）
- [ ] 「単方向依存」（低レイヤ→高レイヤ）になるよう配置を決める
- [ ] 移動に伴うテストの追加/修正方針を決める（最低限: 既存テストが同じ意図を担保する）

### `attachments.ts` / `promptComposer.ts`
- [ ] “composer root/scope 探索” を共通関数へ寄せる設計に合意
- [ ] “シグナル収集” と “判定” と “リトライ戦略” を分離する設計に合意
- [ ] evaluate 文字列の生成/実行/正規化（`unknown → typed`）の境界を決める

### `index.ts` / `reattach.ts`
- [ ] 共通化する範囲を定義（cookie/apply, navigate/login, prompt ready など）
- [ ] 例外/回復系（detach, reconnect, watchdog）の責務をどこに置くか決める

## 5) 実行手順（小さく安全に進める）

推奨: “設計→最小移動→テスト→次の移動” のループ。

- [ ] Step A: 純粋な “移動だけ” をする（挙動変更なし、export を保つ）
- [ ] Step B: 重複を消す（共通関数に寄せる）
- [ ] Step C: 型/返り値の正規化を強める（`unknown` を減らす）
- [ ] Step D: 不要な分岐/ログ/古い互換コードを整理する（必要なら別Step）

## 6) テスト/検証

- [ ] ローカルテスト（最小）: `pnpm vitest run`
- [ ] 影響範囲テスト: `pnpm vitest run tests/browser`（browser DOM/evaluate 周り）
- [ ] リファクタ後の差分が “挙動変更なし” を満たす（意図した変更がある場合はドキュメント化）
- [ ]（任意）live smoke（キー/環境がある場合のみ）:
  - [ ] `ORACLE_LIVE_TEST=1 ORACLE_LIVE_TEST_FAST=1 pnpm vitest run tests/live/browser-fast-live.test.ts`
  - [ ] `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/browser-new-chat-live.test.ts`

## 7) ドキュメント/互換性の最終確認

- [ ] `docs/browser-mode.md` / `docs/configuration.md` / CLI help の記述が一致している
- [ ] 既存 session metadata が読める（後方互換の確認）
- [ ] `.Plans/refactoring/10-changed-files.md` の所見を更新（実施した内容を反映）

## 8) 片付け

- [ ] 未コミット変更が残っていない（または意図が明記されている）
- [ ] ローカル生成物が差分に混ざらない（`.gitignore` / 生成先の見直し）
- [ ] 次の作業者が追える状態（設計メモ/決定事項/残タスクが更新済み）

