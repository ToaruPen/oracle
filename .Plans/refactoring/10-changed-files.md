# 変更ファイル棚卸し（責務 / 変更内容 / 所見）

対象: `upstream/main..origin/main`（+ working tree の未コミット）

差分サマリ（`git diff --stat upstream/main..origin/main`）:
- 変更: 50 files / `+2662 -903`
- 追加: `scripts/setup-local-agent.sh`, `src/browser/actions/newConversation.ts`, いくつかのテストファイル

凡例:
- **責務**: そのファイルが担う役割（本来の責務）
- **変更内容**: upstream からの差分の要約
- **所見**: リファクタ・整理の観点（重複/肥大化/境界）

---

## リポジトリ/ツール設定

### `.gitignore`（M, +1/-0）
- 責務: 生成物やローカル環境ファイルの除外。
- 変更内容: `.serena/` を追加。
- 所見: ローカルツール由来の除外は妥当。`.Plans/` を管理対象にするなら `.gitignore` 追加は不要（今回も追加していない）。

### `AGENTS.md`（M, +0/-1）
- 責務: このリポジトリ向けの運用メモ/注意点。
- 変更内容: `npm publish OTP` 取り扱いメモを削除。
- 所見: 上流との差分を減らしたいなら upstream と合わせる/別ドキュメントへ移すのも選択肢。

### `LICENSE`（M, +1/-1）
- 責務: ライセンス文書。
- 変更内容: upstream の壊れた行（`\\g<1>2026 …`）を修正し、`Copyright (c) 2025 …` に変更。
- 所見: upstream 側が明確に壊れているので修正は妥当。ただし年号は要確認（「2025」が意図通りか）。

### `biome.json`（M, +1/-1）
- 責務: Biome 設定（formatter/linter）。
- 変更内容: `$schema` を `2.3.11 → 2.3.10` に変更。
- 所見: `package.json` の Biome バージョンに合わせた整合はOK。将来 upstream 追従時に揺れやすい箇所。

### `package.json`（M, +4/-4）
- 責務: パッケージ定義（deps/スクリプト/バージョン）。
- 変更内容:
  - `version: 0.8.4 → 0.8.2-toarupen.1`
  - `qs` 依存を削除、`zod` を `^4.3.5 → ^4.2.1`、`@biomejs/biome` を `^2.3.11 → ^2.3.10`
  - `linkedom` を devDependencies に追加（DOM系のユニットテスト用）
- 所見: upstream 追従を視野に入れるなら、deps の差分は衝突ポイントになる（どのラインを採用するか要方針）。

### `pnpm-lock.yaml`（M, +187/-73）
- 責務: 依存解決のロック。
- 変更内容: `package.json` の deps 変更に追随。
- 所見: リファクタ作業の途中で不用意に再生成すると差分が膨らむので、意図があるときだけ更新する。

### `tsconfig.json`（WT, +1/-0 / 未コミット）
- 責務: TypeScript 設定。
- 変更内容: `"ignoreDeprecations": "6.0"` を追加（未コミット）。
- 所見: 既存方針（警告をどこまで許容するか）と整合を取る必要あり。コミットするなら理由を残したい。

---

## ドキュメント/リリースノート

### `CHANGELOG.md`（M, +2/-19）
- 責務: 変更履歴（リリースノート）。
- 変更内容: upstream の `0.8.3〜0.8.5` 相当の記載を削り、`0.8.2-toarupen.1` エントリへ寄せた。
- 所見: フォーク独自の配布を想定するなら合理的。upstream 追従/PR を想定するなら扱いを分けた方が揉めにくい。

### `README.md`（M, +1/-1）
- 責務: 使い方・導線。
- 変更内容: browser flags の一覧に `--browser-cleanup-conversation*` を追加し、`--browser-cookie-wait` を削除。
- 所見: CLI 実装/ドキュメントの整合は取れている。upstream のオプションとの差分が増えている点は要注意。

### `docs/browser-mode.md`（M, +4/-2）
- 責務: browser engine の詳細ドキュメント。
- 変更内容:
  - デフォルト timeout を `20m/60s` に明記し、Pro/Thinking は `2h` デフォルトと追記
  - `--browser-cleanup-conversation` を追加
  - `--browser-cookie-wait` の記載を削除
  - “Answer now/今すぐ回答” が placeholder の場合がある旨を追記
- 所見: 「待つ/クリックしない」方針がドキュメント化されていて良い。仕様（実装）と docs の同期を維持したい。

### `docs/configuration.md`（M, +10/-5）
- 責務: `~/.oracle/config.json` の説明。
- 変更内容:
  - browser の timeout 設定例をコメントアウト（未設定時のデフォルトを優先）
  - `cleanupConversation` / `cleanupConversationForce` を追加
  - 未設定時の timeout 規則（非Pro 20m / Pro/Thinking 2h、input 60s）を追記
- 所見: デフォルト値の “single source of truth” をどこに置くか（docs/実装/CLI help）を意識すると整理しやすい。

---

## スクリプト/スキル

### `scripts/browser-tools.ts`（M, +16/-1）
- 責務: browser デバッグ用の補助ツール（Puppeteer で active tab に接続など）。
- 変更内容: `about:blank` を避けて「最後の非空URL tab」を選ぶ。
- 所見: デバッグ導線の安定化として良い。選定ロジックは `browser-tools` 内の共通関数にしてもよい（今後増えるなら）。

### `scripts/setup-local-agent.sh`（A, +223/-0）
- 責務: ローカルフォークを「どこからでも使える」ようにするセットアップ（Codex skill のインストール、PATH wrapper 追加、任意で ChatGPT URL を config に反映）。
- 変更内容: 新規追加。
- 所見: インストール先（`~/.codex/skills` と `~/bin` 等）を触るので、運用方針に合わせて README/Docs に導線があると親切。

### `skills/oracle/SKILL.md`（M, +46/-55）
- 責務: Codex skill としての Oracle CLI 使い方。
- 変更内容:
  - “ローカルフォーク優先” の導線（`oracle-local` / `oracle-mcp-local`）を追加
  - `--browser-cleanup-conversation` や “Answer now を押さない” の注意を追記
  - 例コマンドを `npx @steipete/oracle` → `oracle-local` 中心に更新
  - 長いプロンプトテンプレートを削り、チェックリストへ簡略化
- 所見: このリポジトリ用途には最適化されている。upstream 汎用の内容は別ファイル化すると衝突しにくい。

---

## CLI / config / セッション周り

### `bin/oracle-cli.ts`（M, +24/-8）
- 責務: CLI エントリ（コマンド/フラグ定義）。
- 変更内容:
  - `--browser-cleanup-conversation` / `--browser-cleanup-conversation-force` を追加
  - `--browser-timeout` の説明/デフォルトを “Pro/Thinking 2h; others 20m” に更新
  - `--browser-input-timeout` のデフォルト説明を `30s → 60s`
  - `--browser-cookie-wait` を削除
- 所見: `src/browser/config.ts` のデフォルト規則と一貫している。CLI help と docs の同期は要管理。

### `src/config.ts`（M, +5/-2）
- 責務: `~/.oracle/config.json` の型/読み込み。
- 変更内容: `cookieSyncWaitMs` を削除し、`cleanupConversation*` を追加。
- 所見: config のキーが増えてきたので、browser config のみに関する型/変換の集約（境界の明確化）を検討してもよい。

### `src/cli/browserConfig.ts`（M, +5/-3）
- 責務: CLI flags → browser config への変換。
- 変更内容: `browserCookieWait` を削除し、`browserCleanupConversation*` を追加。
- 所見: “browser config のキー” を増やすたびに、ここ/`browserDefaults`/docs/test の4点更新が必要になる構造。

### `src/cli/browserDefaults.ts`（M, +9/-5）
- 責務: `config.json` の browser デフォルトを CLI options に流し込む。
- 変更内容: `cookieSyncWaitMs` の反映を削除し、`cleanupConversation*` の反映を追加。
- 所見: 将来的に browser defaults のキーが増えると追従コストが上がる。変換表のような形で宣言的にできると事故が減る。

### `src/cli/sessionDisplay.ts`（M, +30/-1）
- 責務: `oracle session` 等の表示/attach 出力。
- 変更内容: 既存 Chrome への reattach 時に `timeout=` を表示（`resolveBrowserConfig` 経由で決定）。
- 所見: reattach で “待つ時間” の見える化は有用。formatDuration は再利用の余地あり（他表示でも使うなら）。

### `src/sessionManager.ts`（M, +43/-3）
- 責務: セッションメタデータの管理（zombie 判定、browser dead 判定、保存パス等）。
- 変更内容:
  - browser config 型更新（`cleanupConversation*` 追加、`cookieSyncWaitMs` 削除）
  - zombie/dead 判定で同一エラー状態を繰り返し書き込まないようにガード（メタファイルの churn を抑制）
- 所見: “状態遷移と永続化” の責務が混ざりやすい領域。状態更新の idempotency を意識すると今後も安定する。

---

## Browser automation（src/browser）

### `src/browser/types.ts`（M, +5/-1）
- 責務: browser mode の共通型定義。
- 変更内容: `BrowserConversationCleanupMode` を追加し、`cookieSyncWaitMs` を削除。
- 所見: 型が増えるほど “オプションの真の定義場所” が分散しやすい（types/config/cli/docs）。

### `src/browser/config.ts`（M, +51/-4）
- 責務: browser config の正規化（env/config の統合、デフォルト決定）。
- 変更内容:
  - `inputTimeoutMs` デフォルトを `60s` に変更
  - `desiredModel` が Pro/Thinking の場合、`timeoutMs` デフォルトを `2h` に変更（未指定時）
  - `cleanupConversation*` を追加（env: `ORACLE_BROWSER_CLEANUP_CONVERSATION*`）
- 所見: デフォルト決定ロジックが厚くなってきたので、境界（“正規化” vs “実行時の判断”）を意識した分割余地あり。

### `src/browser/chromeLifecycle.ts`（M, +0/-2）
- 責務: Chrome 起動/接続まわり（フラグ構成等）。
- 変更内容: `--lang/--accept-lang` 強制を削除。
- 所見: ロケール強制をやめたことで DOM セレクタが多言語対応必須になる。対応範囲（EN/JA）をどこで担保するかがポイント。

### `src/browser/cookies.ts`（M, +2/-45）
- 責務: Cookie 同期（Chrome profile / inline cookie → CDP `Network.setCookie`）。
- 変更内容:
  - inline cookies 優先・正規化（`domain/path/secure` 等の補完）
  - `url` を必ず付与して CDP の取りこぼしを防止、`url` がある場合は `domain` を落として失敗を回避
  - “wait/retry” 相当（`cookieSyncWaitMs`）を削除
- 所見: cookie 同期は環境差の揺れが大きいので、エラー分類（Keychain/ロック/empty/invalid）をログで区別できると運用が楽。

### `src/browser/pageActions.ts`（M, +1/-1）
- 責務: browser actions の再export（集約点）。
- 変更内容: `ensureNewConversation` を追加し、`installJavaScriptDialogAutoDismissal` を削除。
- 所見: ここは “公開API” になりがちなので、export の増減は意図をドキュメント化すると安全。

### `src/browser/actions/newConversation.ts`（A, +363/-0）
- 責務: 既存スレッドに着地した場合に “New chat” を押して新規スレッド開始。
- 変更内容:
  - `/c/<id>` を検出し、DOM 上の user turn 数 + backend probe（`/backend-api/conversation/<id>`）で “既存会話” を判定
  - “New chat” トリガー探索（EN/JA）とクリック（click dispatcher）
  - unit test 向け `findNewChatTriggerForTest` を提供
- 所見: backend probe は強力だが壊れやすい（認可/仕様変更）。DOM-only fallback と責務境界を明確にしておくと保守しやすい。

### `src/browser/actions/navigation.ts`（M, +7/-103）
- 責務: ChatGPT へのナビゲーション、Cloudflare/ログイン検知、prompt ready 判定。
- 変更内容:
  - base URL → 目的 URL への “二段階遷移” を支える `navigateToPromptReadyWithFallback`
  - `/backend-api/me` でログイン検知 + DOM の login CTA 検出で補強
  - “Welcome back” アカウント選択モーダルの自動クリック
  - auth login URL の場合に手動ログイン待機を延長
- 所見: “navigation + auth + anti-bot” が一体化しやすい領域。ユーティリティ（probe/expression）分離の余地がある。

### `src/browser/actions/promptComposer.ts`（M, +184/-28）
- 責務: プロンプト入力、送信、送信後コミット確認。
- 変更内容:
  - focus を click+selection まで含めて強化（ProseMirror/React 対策）
  - `Input.insertText` 取りこぼし時の fallback（`textContent/value` + `InputEvent`）
  - 大きすぎる prompt の truncate を検知して fail fast（fallback upload に繋げる）
  - send button のスコープを “composer 付近” に寄せて誤クリックを減らす
- 所見: DOM 操作 expression が長文化している。`findComposerScope` など共通化すると重複が減る。

### `src/browser/actions/thinkingTime.ts`（M, +0/-2）
- 責務: Thinking time の UI 操作（Pro/Thinking 系）。
- 変更内容: dropdown だけに限定していたフィルタを削除（`aria-haspopup !== 'menu'` のスキップを撤去）。
- 所見: UI 仕様変更への追随に見えるが、Pro モード解除など副作用のリスクもあるので live test とセットで管理したい。

### `src/browser/actions/attachments.ts`（M, +184/-306）
- 責務: 添付アップロード（ファイル input / DataTransfer）、状態判定、既存添付のクリア。
- 変更内容:
  - composer root/scope の探索を強化（send ボタン/プロンプトを手がかりに “正しい composer” を狙う）
  - “input に入っただけ” を成功とみなさず、chip/UI/アップロード状態など複数シグナルで確定
  - `clearComposerAttachments` / `waitForAttachmentCompletion` / `waitForUserTurnAttachments` の挙動更新
- 所見: 文字列式（CDP evaluate）の塊が巨大化している。シグナル収集/評価/リトライ戦略を関数分割すると見通しが良くなる。

### `src/browser/actions/assistantResponse.ts`（M, +508/-56）
- 責務: assistant 応答の検出・取得（text/html/markdown）と “完了” 判定。
- 変更内容:
  - “Answer now/今すぐ回答” を含む placeholder turn を検知して無視（EN/JA、ラベルのみの turn も含む）
  - DOM observer + snapshot watchdog の二経路で応答キャプチャを堅牢化
  - HTML→Markdown 変換ロジックを内包し、テスト用 export（`htmlToMarkdownForTest` 等）を追加
  - turnId/messageId のメタ情報を返す
- 所見: ファイルが巨大（変換・抽出・監視・デバッグが同居）なので、責務分割の優先度が高い。

### `src/browser/index.ts`（M, +227/-36）
- 責務: browser mode 実行のオーケストレーション（Chrome 起動→cookie→nav→モデル→送信→待機→結果）。
- 変更内容:
  - base URL へ先に遷移→必要なら目的 URL へ（interstitial 対策）
  - `ensureNewConversation` を導入（/c 復元で既存スレッドに入った場合の対策）
  - Pro/Thinking のデフォルト timeout を延長する前提で実行フロー/ログを調整
  - runtime hint（tabUrl/targetId/conversationId）をより多く保存
  - 成功後の `cleanupConversation`（none/archive/delete）を実装
- 所見: “実行フロー” と “回復/デバッグ” と “後処理（cleanup）” が増えてきたため、段階（setup/run/post）で責務分割しやすい。

### `src/browser/reattach.ts`（M, +27/-3）
- 責務: 既存 browser session への再接続・復旧。
- 変更内容:
  - `resolveBrowserConfig` を通して timeout を統一（デフォルト 2h なども反映）
  - cookie 適用ログ/inline cookies 対応を `index.ts` と揃える
  - `cookieSyncWaitMs` を削除
- 所見: `index.ts` と似た処理が多い（cookie/nav/login/prompt）。共通化できると差分が減る。

### `src/browser/sessionRunner.ts`（M, +5/-0）
- 責務: セッション実行の薄いラッパー（prompt 組み立て→browser 実行→usage/runtime の記録）。
- 変更内容: runtime に `chromeTargetId/tabUrl/conversationId` を含めるよう更新。
- 所見: runtime metadata の拡張は reattach/デバッグに効く。schema の進化は互換性（既存 session）を意識したい。

---

## テスト

### `tests/browser/assistantResponsePlaceholder.test.ts`（A, +37/-0）
- 責務: “Answer now/今すぐ回答” placeholder 判定のユニットテスト。
- 変更内容: 新規追加（EN/JA、ラベル単体、isFinished 条件など）。
- 所見: 仕様が UI 依存なので、テストケースは増やしておく価値がある。

### `tests/browser/htmlToMarkdown.test.ts`（A, +29/-0）
- 責務: HTML→Markdown 変換のユニットテスト。
- 変更内容: 新規追加（inline code / link / nested list）。
- 所見: `linkedom` を導入した意図が明確。変換仕様の “期待値” をここに固定できる。

### `tests/browser/newConversationTrigger.test.ts`（A, +29/-0）
- 責務: “New chat” トリガー探索のユニットテスト。
- 変更内容: 新規追加（data-testid、EN/JA aria-label）。
- 所見: UI セレクタが壊れやすいので、最小ケースで守るのは有効。

### `tests/browser/reattach.newChromeRecovery.test.ts`（A, +105/-0）
- 責務: reattach が既存 Chrome に繋がらない場合の “新規 Chrome 復旧” を検証。
- 変更内容: 新規追加（mocks + 期待 URL 遷移 + markdown capture）。
- 所見: 回復系は regress しやすいのでテスト化は良い。mocks の責務分離（fixture）も候補。

### `tests/browser/config.test.ts`（M, +7/-0）
- 責務: `resolveBrowserConfig` のユニットテスト。
- 変更内容: Pro/Thinking の timeout デフォルト（2h）を追加検証。
- 所見: デフォルト規則は docs/CLI とセットで崩れやすいのでテストがあるのは良い。

### `tests/browser/cookies.test.ts`（M, +0/-52）
- 責務: cookie sync のユニットテスト。
- 変更内容: “wait/retry” 系テストを削除（`cookieSyncWaitMs` 廃止に追随）。
- 所見: cookie 周りは上流追従時に再導入される可能性があるので、差分意図をメモしておくと後で楽。

### `tests/browser/attachmentsCompletion.test.ts`（M, +5/-27）
- 責務: 添付アップロード完了判定のフォールバック挙動テスト。
- 変更内容: “send disabled でも安定していれば成功” 等、判定仕様変更に追随。
- 所見: 「安定」の定義が曖昧になりやすいので、ログ/状態出力を増やしてデバッグ可能性を担保したい。

### `tests/browser/pageActions.test.ts`（M, +0/-19）
- 責務: pageActions 経由の挙動テスト（主に attachments）。
- 変更内容: `waitForAttachmentVisible` の “file input name match” ケースを削除。
- 所見: 判定経路が変わった結果と思われる。網羅性が落ちていないかは要確認。

### `tests/browser/promptComposerExpressions.test.ts`（M, +16/-1）
- 責務: prompt composer の evaluate expression の健全性テスト。
- 変更内容: send button 探索を “composer scope” に寄せる式のテストを追加。
- 所見: 文字列 expression は壊れやすいので、こうした “静的テスト” は維持したい。

### `tests/browser/reattach.e2e.test.ts`（M, +3/-3）
- 責務: reattach の疑似 E2E テスト。
- 変更内容: テスト timeout 引数を削除（デフォルトに委ねる）。
- 所見: 実行時間が安定しているならOK。遅い場合は上限管理を戻す余地あり。

### `tests/browser/sessionRunner.test.ts`（M, +50/-0）
- 責務: sessionRunner の戻り値（usage/runtime/log 制御）のテスト。
- 変更内容: `tabUrl/conversationId` など runtime 拡張の検証を追加。
- 所見: セッション互換性が重要な領域なので、schema 変更時はここを中心に増やすと安心。

### `tests/cli/browserConfig.test.ts`（M, +10/-2）
- 責務: CLI → browser config 変換のテスト。
- 変更内容: `cleanupConversation*` を通すケース追加、`cookieSyncWaitMs` を削除。
- 所見: CLI/config の整合性を守るテストとして重要。

### `tests/cli/browserDefaults.test.ts`（M, +15/-2）
- 責務: `config.json` の browser defaults を CLI options に反映するテスト。
- 変更内容: `cleanupConversation*` の反映ケース追加、`cookieSyncWaitMs` を削除。
- 所見: デフォルト伝播の回帰を防げる。

### `tests/cli/browserConfig.inlineCookies.test.ts`（M, +13/-21）
- 責務: inline cookies の読み込みパスのテスト。
- 変更内容: 一部の `try/finally` を簡略化（tmp dir cleanup がなくなっている）。
- 所見: テスト資材が `/tmp` に残り得る点は微妙（必要なら後で整理）。

### `tests/live/browser-fast-live.test.ts`（M, +66/-0）
- 責務: ChatGPT browser mode の live smoke（FAST）。
- 変更内容:
  - project URL missing 時の fallback 検証
  - 添付アップロード検証
  - Markdown（箇条書き/フェンス）保持の検証
- 所見: live テストは opt-in 前提で良い。環境依存が強いので timeout/ロック運用をセットにする。

### `tests/live/browser-new-chat-live.test.ts`（A, +98/-0）
- 責務: “project URL を連続で叩いても新規スレッドにする” live テスト。
- 変更内容: 新規追加（2回実行して `/c/<id>` が変わることを検証）。
- 所見: 新規チャット開始ロジックの回帰検知として価値が高い。

### `tests/sessionStore.test.ts`（M, +3/-4）
- 責務: sessionStore のログ writer 結合テスト。
- 変更内容: `node:stream/promises` の `finished()` を使わず、`close` イベント待ちに置換。
- 所見: Node バージョン/互換の都合に見える。ユーティリティ化して他テストにも適用するなら一箇所に寄せたい。

