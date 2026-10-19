# 企業特集の求人リンク切れ

WordPress の Broken Link Checker（ローカル版）で、フィルタ「企業特集_求人リンク」に出た求人リンクの現状をまとめる。

定期実行のスケジュールはまだ無い。再判定は次のバッチで手元から実行する。

## バッチ

```bash
python3 check_links.py --input broken-jobs-2026-10-19.json
```

標準ライブラリだけで動く。入力 JSON の求人 URL を再リクエストし、まだ切れている行だけを `out/` へ出す。

- `broken-jobs-YYYYMMDD.json`
- `企業特集_求人リンク切れ_YYYYMMDD.csv`（UTF-8 BOM）

判定は次のとおり。

| 現状 | 判定 |
| --- | --- |
| 掲載 URL が 404 など | 求人終了 |
| 301 などで遷移し、遷移先も 404 など | 旧URL。遷移先の求人も終了 |
| 200 で開ける | 一覧から外す（標準出力に「復帰」と出る） |

「エラー継続」と「BLC最終チェック」は Broken Link Checker の表示を引き継ぐ。HTTP の再判定だけでは更新しない。

## 新しい切れの拾い方

企業特集の公開 HTML には求人 URL が入っていない。新しい切れは管理画面で確認する。

1. [Broken Link Checker（フィルタ f1）](https://www.r-agent.com/guide/wp-admin/admin.php?page=blc_local&filter_id=f1) を開く。フィルタ名は「企業特集_求人リンク」。
2. リンクエラーと、遷移先が終了しているリダイレクトを、入力 JSON と同じ列で足す。
3. 上のバッチを回して CSV を出す。

列は次の順。

掲載ページ / 掲載ページURL / 求人名 / 掲載されている求人URL / 判定 / HTTP / リダイレクト先 / リダイレクト先の現状 / エラー継続 / BLC最終チェック / WP編集

## スプレッドシート

[【RDS・RAG特集記事】進捗管理シート](https://docs.google.com/spreadsheets/d/1QR_zn768KnvHG1NfKGvIphvMeNUgA1ZN6i-XTculiBw/edit?gid=250674702#gid=250674702) の「RAGサイト_求人リンク切れ」タブ。

2026-10-19 時点の 21 件は A1:K22 に入っている。A1 の数式が Z1 の1セルを分割している。Z 列は非表示にしてよい。Z1 を消すと表も消える。

CSV で入れ直すときは、このタブだけを対象に「現在のシートを置換」する。他のタブは置換しない。
