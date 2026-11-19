# Current Session

## Last Agent
Antigravity

## Date
2026-11-19

## Completed
- Cloudflare Workers + D1 通知バックエンド基盤を構築・本番デプロイ（`https://seisho-tsudoku-notifications.bdmsw788.workers.dev`）
  - 本番 D1 データベース `seisho-tsudoku-notifications` 作成およびリモートマイグレーション（`0001_init.sql`）適用
  - VAPID 鍵ペアを生成し Cloudflare Workers Secrets へ登録
  - 毎分 Cron (`* * * * *`) による動的通知枠配信・重複送信防止・枠削除時の連動履歴クリーンアップを実装
- PWA 基盤と iPhone 専用プッシュ通知 UI を実装
  - `manifest.json`, `icon-180.png`, Push 受信専用の `sw.js`（fetch キャッシュなし）を追加
  - `index.html` に和紙調の「通知設定」モーダルとベルボタンを局所追加（初回登録時に朝 07:00・昼 12:00・夜 21:00 を自動生成、以降は「＋ 通知を追加」（初期名「追加通知」）・名前編集・時刻編集（時刻順自動整理）・ON/OFF・確認付き削除・0件対応）
  - iPhone ホーム画面 Web アプリ専用制御（Mac 等では通知機能を動かさず案内のみ表示）
  - iPhone の時刻ピッカー操作中の途中保存・強制終了バグを「保存／戻す」バー方式へ修正
- 複数章の通読箇所で1章ずつチェック（全章揃うと自動完了）＆直接チェックの両対応を実装（`prs.app` 外部リンクも未読の最初の章へ誘導）
- `.gitignore` と `.vercelignore` を更新し、ローカル秘密情報や `worker/` が公開・誤コミットされないよう保護

## Currently Working On
- 本番環境（Vercel / Cloudflare Workers）への公開完了と実機 iPhone での通知動作確認（ステップ3）

## Next Tasks
1. 実機 iPhone での動作確認（ホーム画面追加・通知オン・朝昼夜3枠表示・テスト通知・追加/編集/削除・定時配信）
2. 「夜の儀式」画面（一日の振り返り日記欄 ＋ 明日の最重要タスク3つ）の設計・実装検討

## Known Issues
- 既存の iPhone ホーム画面アイコンに `manifest.json` を反映させるには、一度最新の `https://seisho-tsudoku-app.vercel.app` を Safari で開き直して「ホーム画面に追加」し直す必要がある場合がある（その際は既存の「引き継ぎコードをコピー／読み込む」で進捗を保護・復元可能）
- 複雑な聖書箇所（章またぎ）で外部リンク（prs.app）が最初の章のみを開く仕様

## Tests
- Worker 自動テスト（`cd worker && npm test`）: 通知4スイート＋クラウドバックアップ・OTP認証・買い切り／教会ライセンス4スイート（計8スイート）すべて合格
- Wrangler ローカル D1 マイグレーション（`0001_init.sql`, `0002_cloud_backup.sql`）および `wrangler deploy --dry-run`: 成功
- `index.html` Node VM 統合検証（構文チェック・全66巻メタデータ・節目達成カードCanvas生成・今日の一言メモ保存／削除・`mergeAppStates` 部分章マージ＆自動昇格・教会専用スタートリンク `?church=...&invite=...`・セーフエリア／下部ピルバー保持確認）: すべて合格

## Important Decisions
- 通知枠は固定カラム・固定配列にせず、D1 の `notification_slots` テーブルで1枠1レコードの動的管理とし、0件〜自由増減・時刻順自動整理を採用
- フロントエンドは既存の Vercel URL（`https://seisho-tsudoku-app.vercel.app/`）を維持し、通知・自動クラウドバックアップ・ライセンス認証 API を Cloudflare Workers + D1 で提供
- **節目ごとの「和紙調・達成カード画像」（Phase 1）**：連続日数・1巻読破・レベルアップ・プラン完走時に 1080×1080 PNG カード（和紙／夜庭テーマ）を Canvas 生成し、Web Share API（LINE／Instagram等）や画像保存に対応。「庭の成長」からもいつでも生成可能。教会名が設定されている場合はカード下部に教会名クレジットを自動印字
- **「今日の一言メモ」＋「自動クラウドバックアップ」＋「買い切り／教会ライセンス」（Phase 2）**：
  - 今日の通読カード内に最大500文字の一言メモ欄と「過去のメモ一覧」モーダルを追加（`state.notes`）
  - パスワード不要の6桁メール OTP 認証（Resend または Google Apps Script Gmail 中継の両対応）と D1 `user_backups` による自動バックアップ・3択マージ復元（`mergeAppStates`）を実装
  - 一人運営で手間ゼロの有料化として、`invite_codes` テーブルによる **個人買い切り解放コード** と **教会ライセンス（共通コード＋教会名入り専用スタートリンク `?church=教会名&invite=コード`）** に対応。一度登録したメールアドレスは機種変更時にコード再入力不要で復元可能。`npm run license:create` で即時発行可能
- 既存のセーフエリア（`env(safe-area-inset-top)`）、下部浮遊ピルバー（`.bottom-nav`）、手動の「引き継ぎコード」機能は一切壊さず維持

## Files Changed
- `index.html` (局所編集：和紙調・達成カード生成モーダル、今日の一言メモ＆履歴モーダル、自動クラウドバックアップ＆解放コード／教会専用リンク対応)
- `worker/migrations/0002_cloud_backup.sql` (新規作成：`invite_codes`, `users`, `auth_codes`, `user_sessions`, `user_backups` テーブル定義＆初期シード)
- `worker/src/lib/mailer.js` (新規作成：Resend / GAS Gmail 中継デュアルアダプタ)
- `worker/src/lib/backup.js` (新規作成：6桁メール OTP 認証、買い切り／教会ライセンス検証、クラウドバックアップ CRUD)
- `worker/src/index.js` (更新：CORS `PUT` 許可および `/api/auth/*`, `/api/backup`, `/api/license/check` ルーティング追加)
- `worker/scripts/gas-mail-relay.gs` (新規作成：Google Apps Script メール中継スクリプト)
- `worker/scripts/manage-license.mjs` / `worker/package.json` (新規作成・更新：買い切りコード・教会ライセンス＆専用スタートリンク発行 CLI)
- `worker/.dev.vars.example` (更新：メール設定の環境変数項目名追記)
- `worker/test/backup.test.mjs` (新規作成：OTP・レート制限・ライセンス検証・バックアップ統合テスト)
- `docs/SESSION.md` (更新)

## Notes for Next Agent
- `index.html` を編集する際は、必ず該当箇所のみをピンポイントで変更してください。ファイル全体の書き換えは避けてください。
- iPhoneのSafariでホーム画面に追加して使用する前提のため、ステータスバーやセーフエリア（`env(safe-area-inset-top)` 等）の余白を絶対に崩さないでください。
- 聖書の本文・引用は必ず「新改訳2017」を用い、不確かな場合は「要確認」としてください。
- Worker を変更した場合は `cd worker && npm test` を実行してから `npx wrangler deploy` してください。秘密情報（`VAPID_PRIVATE_KEY` 等）は絶対にコード・出力・Git に含めないでください。
