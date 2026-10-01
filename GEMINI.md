# Gemini / Antigravity Development Guidelines (GEMINI.md)

このリポジトリは「みことばの庭 (seisho-tsudoku-app)」です。
Gemini / Antigravity が作業を行う際は、ルートの `AGENTS.md` および `docs/HANDOFF_CLAUDE_TO_ANTIGRAVITY.md` に定義されたルールを最優先してください。

## 主な遵守事項
1. 既存のClaudeの設計意図を尊重し、フレームワークの導入や大規模な書き換えを勝手に行わない。
2. `index.html` の編集は最小限かつ局所的に行い、各ステップで動作確認する。
3. 聖書引用は「新改訳2017」を基準とし、不確かな場合は「要確認」とする。
4. セーフエリア（`env(safe-area-inset-top)`）および下部浮遊ピルバーのUIを崩さない。
5. 作業終了時は `docs/SESSION.md` を更新する。
