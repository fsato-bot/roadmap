#!/usr/bin/env python3
"""ダイレクトスカウトの企業特集記事から求人リンクを集め、切れているものだけ出す。

公開HTMLの job_descriptions リンクを見る。管理画面には入らない。
前回までに出した求人URLは state/rds-reported.json に覚え、次回は新しい切れだけを追記分にする。
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from urllib.parse import urljoin

ORIGIN = "https://directscout.recruit.co.jp"
API = ORIGIN + "/contents/wp-json/wp/v2/posts"
CATEGORY_ID = 185
USER_AGENT = "rds-job-link-check/1.0"
REDIRECTS = {301, 302, 303, 307, 308}

HEADER = [
    "会社名",
    "掲載ページ",
    "掲載ページURL",
    "求人名",
    "掲載されている求人URL",
    "判定",
    "HTTP",
    "リダイレクト先",
    "リダイレクト先の現状",
    "確認日",
    "WP編集",
    "対応",
    "掲載求人有無",
    "削除日",
]

ITEM_RE = re.compile(r'<div class="job-link-item\b', re.I)
OVERVIEW_RE = re.compile(r'class="job-link-item__overview">(.*?)</div>', re.I | re.S)
COMPANY_RE = re.compile(r"<th>\s*会社名\s*</th>\s*<td>(.*?)</td>", re.I | re.S)
HREF_RE = re.compile(
    r'href="(https://directscout\.recruit\.co\.jp/job_descriptions/\d+)/?"',
    re.I,
)
TAG_RE = re.compile(r"<[^>]+>")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def fetch(url: str, timeout: float) -> tuple[int | None, str, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with OPENER.open(request, timeout=timeout) as response:
            return response.status, "", response.read()
    except urllib.error.HTTPError as error:
        location = error.headers.get("Location") or ""
        if location:
            location = urljoin(url, location)
        body = error.read() if error.fp else b""
        return error.code, location, body
    except urllib.error.URLError as error:
        print(f"取得失敗 {url}: {error.reason}", file=sys.stderr)
        return None, "", b""


def text_of(fragment: str) -> str:
    cleaned = TAG_RE.sub("", fragment)
    return html.unescape(re.sub(r"\s+", " ", cleaned)).strip()


def list_articles(timeout: float) -> list[dict]:
    articles = []
    page = 1
    while True:
        url = (
            f"{API}?categories={CATEGORY_ID}&status=publish"
            f"&per_page=100&page={page}&_fields=id,link,title"
        )
        status, _, body = fetch(url, timeout)
        if status != 200:
            raise SystemExit(f"記事一覧の取得に失敗しました: HTTP {status}")
        chunk = json.loads(body.decode("utf-8"))
        if not chunk:
            break
        articles.extend(chunk)
        if len(chunk) < 100:
            break
        page += 1
    return articles


def jobs_in_html(raw: str) -> list[tuple[str, str, str]]:
    found: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    parts = ITEM_RE.split(raw)
    for block in parts[1:]:
        hrefs = HREF_RE.findall(block)
        if not hrefs:
            continue
        url = hrefs[0]
        if url in seen:
            continue
        seen.add(url)
        overview = OVERVIEW_RE.search(block)
        company = COMPANY_RE.search(block)
        found.append(
            (
                text_of(overview.group(1)) if overview else "",
                text_of(company.group(1)) if company else "",
                url,
            )
        )
    if found:
        return found
    for url in dict.fromkeys(HREF_RE.findall(raw)):
        found.append(("", "", url))
    return found


def article_jobs(article: dict, timeout: float) -> list[dict]:
    status, _, body = fetch(article["link"], timeout)
    if status != 200:
        print(f"記事を読めません {article['link']}: HTTP {status}", file=sys.stderr)
        return []
    title = text_of(article["title"]["rendered"])
    edit = f"{ORIGIN}/contents/wp-admin/post.php?post={article['id']}&action=edit"
    rows = []
    for job_name, company, job_url in jobs_in_html(body.decode("utf-8", "replace")):
        rows.append(
            {
                "page": title,
                "page_url": article["link"],
                "job": job_name,
                "company": company,
                "job_url": job_url,
                "edit": edit,
            }
        )
    return rows


def judge(url: str, timeout: float) -> tuple[str, str, str, str] | None:
    status, location, _ = fetch(url, timeout)
    if status is None:
        return None
    if status in REDIRECTS and location:
        target_status, _, _ = fetch(location, timeout)
        if target_status is not None and target_status >= 400:
            return "旧URL。遷移先の求人も終了", str(status), location, str(target_status)
        return None
    if status >= 400:
        return "求人終了", str(status), "", ""
    return None


def load_reported(path: Path) -> set[str]:
    if not path.exists():
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    return set(data.get("keys", []))


def save_reported(path: Path, keys: set[str], checked: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"checked": checked, "keys": sorted(keys)}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def row_key(page_url: str, job_url: str) -> str:
    page = page_url.split("?", 1)[0].rstrip("/")
    job = job_url.split("?", 1)[0].rstrip("/")
    return page + "\t" + job


def write_outputs(rows: list[list[str]], out_dir: Path, checked: str, articles: int, jobs: int) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = checked.replace("-", "")
    payload = {
        "checked": checked,
        "source": "directscout 企業特集記事",
        "category_id": CATEGORY_ID,
        "articles": articles,
        "job_links": jobs,
        "broken": len(rows),
        "header": HEADER,
        "rows": rows,
    }
    json_path = out_dir / f"rds-broken-jobs-{stamp}.json"
    csv_path = out_dir / f"RDS_企業特集_求人リンク切れ_{stamp}.csv"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["確認日", checked, "対象", "企業特集記事", "記事数", articles, "求人リンク", jobs, "新規の切れ", len(rows)]
        )
        writer.writerow(HEADER)
        writer.writerows(rows)
    return json_path, csv_path


def main() -> int:
    parser = argparse.ArgumentParser(description="ダイレクトスカウト企業特集の求人リンク切れを集める")
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent / "out")
    parser.add_argument("--state", type=Path, default=Path(__file__).resolve().parent / "state" / "rds-reported.json")
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--full", action="store_true", help="既出も含めて、今切れている行をすべて出す")
    args = parser.parse_args()

    checked = date.today().isoformat()
    articles = list_articles(args.timeout)
    print(f"企業特集記事 {len(articles)} 件", flush=True)

    collected: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(article_jobs, article, args.timeout) for article in articles]
        done = 0
        for future in as_completed(futures):
            collected.extend(future.result())
            done += 1
            if done % 25 == 0 or done == len(articles):
                print(f"記事 {done}/{len(articles)} 求人リンク {len(collected)}", flush=True)

    unique_urls = list(dict.fromkeys(item["job_url"] for item in collected))
    print(f"求人URL {len(unique_urls)} 件を確認", flush=True)
    verdicts: dict[str, tuple[str, str, str, str] | None] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(judge, url, args.timeout): url for url in unique_urls}
        done = 0
        for future in as_completed(futures):
            verdicts[futures[future]] = future.result()
            done += 1
            if done % 50 == 0 or done == len(unique_urls):
                print(f"確認 {done}/{len(unique_urls)}", flush=True)

    reported = set() if args.full else load_reported(args.state)
    alive_pages = {
        item["page_url"].split("?", 1)[0].rstrip("/")
        for item in collected
        if verdicts.get(item["job_url"]) is None
    }
    rows: list[list[str]] = []
    new_keys: set[str] = set()
    broken_keys: set[str] = set()
    for item in collected:
        verdict = verdicts.get(item["job_url"])
        if verdict is None:
            continue
        key = row_key(item["page_url"], item["job_url"])
        broken_keys.add(key)
        if key in reported:
            continue
        label, http, redirect, redirect_now = verdict
        page = item["page_url"].split("?", 1)[0].rstrip("/")
        rows.append(
            [
                item["company"],
                item["page"],
                item["page_url"],
                item["job"],
                item["job_url"],
                label,
                http,
                redirect,
                redirect_now,
                checked,
                item["edit"],
                "未対応",
                "あり" if page in alive_pages else "なし",
                "",
            ]
        )
        new_keys.add(key)

    json_path, csv_path = write_outputs(rows, args.out_dir, checked, len(articles), len(collected))
    save_reported(args.state, reported | broken_keys, checked)
    print(f"新規の切れ {len(rows)} 件")
    print(f"今も切れている掲載 {len(broken_keys)} 件")
    print(json_path)
    print(csv_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
