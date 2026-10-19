#!/usr/bin/env python3
"""既知の求人リンクを再リクエストし、切れているものだけ CSV / JSON に出す。

公開中の企業特集ページには求人 URL が HTML に含まれない。
新規の切れは WordPress の Broken Link Checker（フィルタ「企業特集_求人リンク」）で拾い、
このバッチは拾った URL の現状（404 か、301 の先も 404 か）をまとめる。
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from urllib.parse import urljoin

HEADER = [
    "掲載ページ",
    "掲載ページURL",
    "求人名",
    "掲載されている求人URL",
    "判定",
    "HTTP",
    "リダイレクト先",
    "リダイレクト先の現状",
    "エラー継続",
    "BLC最終チェック",
    "WP編集",
]

REDIRECTS = {301, 302, 303, 307, 308}
USER_AGENT = "rag-job-link-check/1.0"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def fetch_status(url: str, timeout: float) -> tuple[int | None, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="GET")
    try:
        with OPENER.open(request, timeout=timeout) as response:
            return response.status, ""
    except urllib.error.HTTPError as error:
        location = error.headers.get("Location") or ""
        if location:
            location = urljoin(url, location)
        return error.code, location
    except urllib.error.URLError as error:
        print(f"取得失敗 {url}: {error.reason}", file=sys.stderr)
        return None, ""


def judge(url: str, timeout: float) -> tuple[str, str, str, str] | None:
    """切れていれば (判定, HTTP, リダイレクト先, リダイレクト先の現状) を返す。"""
    status, location = fetch_status(url, timeout)
    if status is None:
        return None
    if status in REDIRECTS and location:
        target_status, _ = fetch_status(location, timeout)
        target = "" if target_status is None else str(target_status)
        if target_status is not None and target_status >= 400:
            return "旧URL。遷移先の求人も終了", str(status), location, target
        return None
    if status >= 400:
        return "求人終了", str(status), "", ""
    return None


def recheck(payload: dict, timeout: float) -> tuple[list[list[str]], list[str]]:
    broken: list[list[str]] = []
    recovered: list[str] = []
    for row in payload["rows"]:
        page, page_url, job, job_url, *_rest = row
        error_for = row[8] if len(row) > 8 else ""
        last_check = row[9] if len(row) > 9 else ""
        edit_url = row[10] if len(row) > 10 else ""
        result = judge(job_url, timeout)
        if result is None:
            recovered.append(job_url)
            continue
        label, http, redirect, redirect_now = result
        broken.append(
            [
                page,
                page_url,
                job,
                job_url,
                label,
                http,
                redirect,
                redirect_now,
                error_for,
                last_check,
                edit_url,
            ]
        )
    return broken, recovered


def write_outputs(source: dict, rows: list[list[str]], out_dir: Path, checked: str) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = checked.replace("-", "")
    payload = {
        "checked": checked,
        "filter": source.get("filter", ""),
        "total_in_filter": source.get("total_in_filter"),
        "broken": len(rows),
        "header": HEADER,
        "rows": rows,
    }
    json_path = out_dir / f"broken-jobs-{stamp}.json"
    csv_path = out_dir / f"企業特集_求人リンク切れ_{stamp}.csv"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "確認日",
                checked,
                "対象フィルタ",
                payload["filter"],
                "フィルタ内",
                payload["total_in_filter"] if payload["total_in_filter"] is not None else "",
                "切れ",
                len(rows),
            ]
        )
        writer.writerow(HEADER)
        writer.writerows(rows)
    return json_path, csv_path


def main() -> int:
    parser = argparse.ArgumentParser(description="求人リンクの切れを再判定して CSV と JSON を書く")
    parser.add_argument("--input", type=Path, required=True, help="前回の broken-jobs JSON")
    parser.add_argument("--out-dir", type=Path, default=None, help="出力先。省略時は入力ファイルの隣の out/")
    parser.add_argument("--timeout", type=float, default=15, help="1リクエストのタイムアウト秒")
    args = parser.parse_args()

    source = json.loads(args.input.read_text(encoding="utf-8"))
    rows, recovered = recheck(source, args.timeout)
    checked = date.today().isoformat()
    out_dir = args.out_dir or (args.input.parent / "out")
    json_path, csv_path = write_outputs(source, rows, out_dir, checked)
    print(f"切れ {len(rows)} 件")
    print(f"復帰 {len(recovered)} 件")
    for url in recovered:
        print(f"  復帰: {url}")
    print(json_path)
    print(csv_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
