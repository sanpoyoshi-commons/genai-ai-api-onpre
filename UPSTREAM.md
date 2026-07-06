# UPSTREAM.md

このファイルは、本リポジトリの上流派生関係・上流追従手順・取込履歴を
記録するものです。NOTICE と併せて、本プロジェクトの派生関係を
明示するドキュメントです。

## 1. 現在の上流スナップショット（Current upstream snapshot）

| 項目              | 値                                                  |
| ----------------- | --------------------------------------------------- |
| Upstream URL      | https://github.com/digital-go-jp/genai-ai-api       |
| Upstream tag      | v1.0.3                                              |
| Upstream commit   | ec8add36c730ca7952633f39603f415986ae31f8            |
| 取込日（日本時間）| 2026-05-22                                          |
| 派生方式          | fork ワークフロー（remote 追跡、subtree ではない）  |

## 2. リモート構成
origin    本リポジトリ（ローカル運用用）
upstream  https://github.com/digital-go-jp/genai-ai-api.git（上流、読み取り専用想定）

## 3. 上流追従手順（Update procedure）

新規上流リリース（v1.x.y）取込時の標準手順：

```bash
cd ~/work/genai-ai-api-onpre

# 上流の最新タグを取得
git fetch upstream --tags

# 取込対象タグへ merge（例：v1.1.0）
git checkout main
git merge v1.1.0

# コンフリクト発生時は手動解決
# 派生実装と上流変更の衝突は内容を確認しつつマージする

# 新タグの SHA を記録
git rev-parse v1.1.0

# §5 の Update history を更新（必須運用ルール）

# リモートへ反映
git push origin main
git push origin --tags
```

## 4. 上流追従時の必須チェック

| #     | チェック内容                                                       |
| ----- | ------------------------------------------------------------------ |
| 4-1   | lawsy-custom-bq 部分の変更有無確認（今後の取込部分）                |
| 4-2   | pyproject.toml／poetry.lock など Python 依存変更を確認              |
| 4-3   | 本 UPSTREAM.md の §1 と §5 を更新                                  |
| 4-4   | 上流タグの GPG 署名 fingerprint 確認（導入検討中）                  |

## 5. 取込履歴（Update history）

| 取込日     | タグ    | Commit SHA                                | 備考                       |
| ---------- | ------- | ----------------------------------------- | -------------------------- |
| 2026-05-22 | v1.0.3  | ec8add36c730ca7952633f39603f415986ae31f8  | 初回取込（fork ワークフロー初期セットアップ） |

## 6. 運用注記

### 6-1. タグだけ進む現象の扱い

上流リポジトリで「タグだけ付与され、公開 Release（GitHub Releases ページに
リリースノート付きで公開されたもの）として正式リリースされない」現象が
発生した場合、本プロジェクトは **追従しません**。

公開 Release が出るまで現在のタグに据え置き、定期棚卸し時に状況を
把握するに留めます。

### 6-2. クールダウン期間

新規 Release 公開後、本プロジェクトの依存クールダウン規約に従い、
最低 7 日経過後に取込を検討します。CVSS 9.0 以上かつ未認証リモート
攻撃可能な脆弱性が発見された場合は、本規約のクールダウン特例条項
（4 条件すべて成立）の判断に従い、上記期間内であっても採用判断
される場合があります。

詳細運用は本プロジェクト内部の依存クールダウン環境変数設定運用に
従います。

## 7. 関連ファイル

- LICENSE                                 ソフトウェアライセンス（MIT）
- LICENSE-CC-BY                           ドキュメントライセンス（CC BY 4.0）
- NOTICE                                  上流派生関係・商標注記・免責事項
- LICENSES-THIRD-PARTY/                   第三者依存ライセンス本文集
- tools/law-rag-ingest/README.md          lawsy-custom-bq 由来コードの出典・改変表示（「ライセンス・由来（attribution）」節。取扱は NOTICE 参照）

## 8. 一次出典

- 上流リポジトリ：https://github.com/digital-go-jp/genai-ai-api
- 上流 v1.0.3 タグ：https://github.com/digital-go-jp/genai-ai-api/releases/tag/v1.0.3
- GitHub Releases ページ：https://github.com/digital-go-jp/genai-ai-api/releases
- lawsy-custom-bq 関連：[Lawsy ecosystem 公式ドキュメント参照]
