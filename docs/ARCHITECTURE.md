# システム設計・アーキテクチャ仕様書 (ARCHITECTURE.md)

## 1. システム全体像

本アプリケーションは、**完全な単一ファイルHTML（Single-File Web Application）** として構築されています。
外部のUIフレームワーク（React, Vue, Tailwind CLI等）やビルドツール（Webpack, Vite等）を使用せず、Vanilla HTML5 / CSS3 / JavaScript (ES5/ES6) のみで動作します。

```
[ ブラウザ (iPhone Safari / PWA WebClip) ]
   │
   ├─ UI描画・イベント制御 (Vanilla JS)
   │     ├─ ナビゲーション (浮遊ピルバー / セクションスクロール)
   │     ├─ 今日の通読カード / バックログアコーディオン
   │     ├─ 手書き風SVGイラスト・アニメーション (Canvas Confetti)
   │     └─ ゲーミフィケーション (XP・ツリー成長・レベル算出)
   │
   ├─ データ保存: localStorage (Key: "seisho-tsudoku-niwa-v1")
   │
   ├─ 外部参照: prs.app (「ともに聴く聖書」新改訳2017への外部リンク)
   │
   └─ ホスティング: Vercel (Static Web)
```

## 2. ディレクトリ・ファイル構成

```
bdmsw788/seisho-tsudoku-app/
├── index.html          # アプリ本体 (HTML/CSS/JS 全内包, 約100KB, 1751行)
├── AGENTS.md           # 全AIエージェント共通開発規約
├── CLAUDE.md           # Claude用設定・指針
├── GEMINI.md           # Gemini / Antigravity用設定・指針
├── .env.example        # 環境変数例
├── .gitignore          # Git除外設定 (.env*.local, .vercel)
└── docs/
    ├── HANDOFF_CLAUDE_TO_ANTIGRAVITY.md # 引き継ぎ書正本
    ├── PROJECT.md      # プロジェクト概要・目的
    ├── ARCHITECTURE.md # 技術アーキテクチャ (本書)
    ├── DECISIONS.md    # 設計決定・経緯記録 (ADR)
    └── SESSION.md      # セッション作業記録
```

## 3. スタイリング・デザイン設計

### カラーパレット（CSSカスタムプロパティ）
- `--paper` (`#F1EBDC` / Dark: `#1B1C21`): 和紙のような温かみのある背景。
- `--paper-raised` (`#FBF8F0` / Dark: `#25272F`): カードなどの浮き上がり要素。
- `--paper-sunken` (`#E5DDC7` / Dark: `#16171B`): くぼみ・帯要素。
- `--ink` (`#2B2A22` / Dark: `#ECE6D6`): 墨のようなテキスト色。
- `--indigo` (`#2E4459` / Dark: `#93B2CC`): 知性と静けさを表す藍色。
- `--gold` (`#AC7C24` / Dark: `#E3B354`): 価値と祝福を表す金色。
- `--sage` (`#586B49` / Dark: `#9BB587`): 植物の生命力を表す萌葱（セージ）色。

### タイポグラフィ（Google Fonts）
- `--font-display`: `"Shippori Mincho", serif`（見出し、格式と伝統）
- `--font-body`: `"Zen Kaku Gothic New", sans-serif`（本文、高い可読性）
- `--font-accent`: `"Klee One", sans-serif`（聖句カード・手書きの温かみ）

### レスポンシブ＆iOS最適化
- `viewport-fit=cover` と `env(safe-area-inset-top/left/right)` による全画面表示対応。
- 下部ナビゲーションは `position: fixed` の浮遊ピル型で、画面最下部のセーフエリアおよびコンテンツとの被りを回避。

## 4. データ構造とストレージ仕様

### localStorage キー
`seisho-tsudoku-niwa-v1`

### データスキーマ
```typescript
interface AppState {
  active: string | null;            // 現在選択中のプランID ("streams", "full", "nt90", "gospel")
  plans: {
    [planId: string]: {
      startDate: string;            // 開始日 (YYYY-MM-DD)
      completed: {
        [dayIndex: string]: {       // 1-indexed 日番号
          [refIndex: string]: boolean // その日の何番目の聖書箇所か (0-indexed)
        }
      };
      completedAt: {
        [dayIndex: string]: string  // 完了日時 (ISO 8601)
      };
    };
  };
  bestStreakEver: number;           // 過去最高連続読書日数
  activity: {
    [isoDate: string]: boolean      // 読書活動のあった日付記録
  };
}
```

## 5. 外部連携ロジック（新改訳2017本文へのリンク）

### 仕様
各箇所の横にある外部リンクアイコンをタップすると、「ともに聴く聖書」（prs.app）の新改訳2017（`jdb`）該当章が開く。
- URL形式: `https://prs.app/ja/bible/{usfm_code}.{chapter}.jdb`
- 書名正規化: `BOOK_CODE_MAP` オブジェクトにより、旧約39巻＋新約27巻の書名表記ゆれ（例：「サムエル記第一」と「サムエル記 第一」など）をUSFMコード（例: `1sa`）にマッピング。
