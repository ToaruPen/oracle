# 所見まとめ（リファクタ候補 / 衝突ポイント）

このファイルは `.Plans/refactoring/10-changed-files.md` の “所見” を横断して、リファクタ候補を整理したものです（まだ実装はしない）。

## 優先度高（巨大ファイルの責務分割）

- `src/browser/actions/assistantResponse.ts`
  - 現状: 監視（observer/poller）・抽出（DOM）・整形（HTML→MD）・デバッグ（snapshot）・テスト用 export が同居。
  - 候補: `extractor` / `watchdog` / `htmlToMarkdown` / `placeholders` / `debug` に分割し、公開 API を薄く保つ。

- `src/browser/actions/attachments.ts`
  - 現状: “composer scope 探索”・“シグナル収集”・“判定”・“リトライ戦略（input/DataTransfer）” が巨大な evaluate 文字列に埋まる。
  - 候補: (1) scope 探索、(2) signal schema、(3) evaluator、(4) retry policy を関数/モジュールで分離（文字列生成も小さく保つ）。

- `src/browser/actions/promptComposer.ts`
  - 現状: focus/clear/insert/verify/send/commit が同居、かつ evaluate 文字列の責務が肥大。
  - 候補: “composer の anchor/scope 探索” を共通化し、submit の手順を段階関数へ分割。

## 優先度中（重複ロジックの集約）

- “prompt node / composer root / scope” 探索が `attachments.ts` と `promptComposer.ts`（他にも）で重複。
  - 候補: `src/browser/actions/composerScope.ts` のような単一責務 helper（DOM のみ）に寄せる。

- CDP `Runtime.evaluate` の “文字列式” が各所で増殖。
  - 候補: “式生成” と “式実行 + 返り値の正規化” を分け、返り値型を TS 側で厳格化（`unknown`→normalize）。

## 優先度中（実行フローの段階化）

- `src/browser/index.ts` / `src/browser/reattach.ts` に同種の処理（cookie/nav/login/prompt）が存在。
  - 候補: “setup（chrome+cookie+nav+login）” と “run（send+wait+capture）” と “post（cleanup+persist）” を共通関数化して差分を減らす。

## 衝突/方針決めポイント（upstream 追従に絡む）

- `cookieSyncWaitMs` の削除（upstream では cookie wait/retry が存在）
  - 方針: fork と upstream をどう整合するか（再導入/廃止/フラグ名変更）を先に決めると後の衝突が減る。

- ロケール強制（`--lang=en-US`）の削除と、日本語 UI ラベル対応の追加
  - 方針: “常に英語固定” へ戻すか、“多言語対応を前提にする” か。多言語前提ならセレクタ/テキスト判定を集約したい。

- `cleanupConversation`（archive/delete）追加
  - 方針: upstream へ出すなら “危険度（delete）” と “/c/<id> URL の扱い” を明確にし、デフォルトの安全性を維持する。

## 小さめの技術的負債（後回し候補）

- `tests/cli/browserConfig.inlineCookies.test.ts` の tmp dir cleanup（簡略化で残骸が残り得る）
- `LICENSE` の年号（意図した値か確認）
- docs/CLI/help のデフォルト説明の同期（いまは揃っているが、今後の変更でズレやすい）

