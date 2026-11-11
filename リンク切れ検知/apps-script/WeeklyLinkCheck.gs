/**
 * 企業特集の求人リンクを公開ページから確認し、新しく切れた行だけを追記する。
 * 毎週月曜 9:00（日本時間、前後15分）。
 * 掲載求人有無は、切れている求人を全部外したあとに生きている求人が残るかで付ける。
 * 削除の成功・失敗では変えない。求人カセットの削除はこの関数では行わない。
 *
 * 初回だけ installWeeklyTrigger を実行し、表示される権限を許可する。
 */

var RDS_SHEET = 'RDSサイト_求人リンク切れ';
var RAG_SHEET = 'RAGサイト_求人リンク切れ';
var HEADER = [
  '会社名',
  '掲載ページ',
  '掲載ページURL',
  '求人名',
  '掲載されている求人URL',
  '判定',
  'HTTP',
  'リダイレクト先',
  'リダイレクト先の現状',
  '確認日',
  'WP編集',
  '対応',
  '掲載求人有無',
  '削除日'
];

function weeklyJobLinkCheck() {
  var book = SpreadsheetApp.getActive();
  var checked = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var rds = crawlRds_(checked);
  var rag = crawlRag_(checked);
  var rdsSheet = book.getSheetByName(RDS_SHEET);
  var ragSheet = book.getSheetByName(RAG_SHEET);
  var rdsAdded = appendNew_(rdsSheet, rds.rows);
  var ragAdded = appendNew_(ragSheet, rag.rows);
  updateAvailability_(rdsSheet, rds.flags);
  updateAvailability_(ragSheet, rag.flags);
  console.log('RDS追加 ' + rdsAdded + ' / RAG追加 ' + ragAdded);
}

function installWeeklyTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'weeklyJobLinkCheck';
  });
  if (existing.length) {
    console.log('トリガーは既にあります');
    return;
  }
  ScriptApp.newTrigger('weeklyJobLinkCheck')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .nearMinute(0)
    .inTimezone('Asia/Tokyo')
    .create();
  console.log('毎週月曜 9:00 のトリガーを追加しました');
}

function updateAvailability_(sheet, flags) {
  if (!sheet || String(sheet.getRange(1, 13).getValue()) !== '掲載求人有無') return;
  var last = sheet.getLastRow();
  if (last < 2) return;
  var urls = sheet.getRange(2, 3, last - 1, 1).getValues();
  var values = sheet.getRange(2, 13, last - 1, 1).getValues();
  var changed = false;
  for (var i = 0; i < urls.length; i++) {
    var flag = flags[cleanUrl_(urls[i][0])];
    if (!flag || values[i][0] === flag) continue;
    values[i][0] = flag;
    changed = true;
  }
  if (changed) sheet.getRange(2, 13, last - 1, 1).setValues(values);
}

function appendNew_(sheet, rows) {
  if (!sheet) {
    throw new Error('シートが見つかりません');
  }
  if (String(sheet.getRange(1, 1).getValue()) !== '会社名') {
    throw new Error(sheet.getName() + ' のA1が会社名ではありません');
  }
  var known = existingKeys_(sheet);
  var fresh = rows.filter(function (row) {
    return !known[keyOf_(row[2], row[4])];
  });
  if (!fresh.length) return 0;
  var start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, fresh.length, HEADER.length).setValues(fresh);
  return fresh.length;
}

function existingKeys_(sheet) {
  var last = sheet.getLastRow();
  var known = {};
  if (last < 2) return known;
  var values = sheet.getRange(2, 3, last - 1, 3).getValues();
  values.forEach(function (row) {
    known[keyOf_(row[0], row[2])] = true;
  });
  return known;
}

function keyOf_(pageUrl, jobUrl) {
  return cleanUrl_(pageUrl) + '\t' + cleanUrl_(jobUrl);
}

function cleanUrl_(url) {
  return String(url || '').split('?')[0].replace(/\/+$/, '');
}

function crawlRds_(checked) {
  var articles = listJson_(
    'https://directscout.recruit.co.jp/contents/wp-json/wp/v2/posts?categories=185&status=publish&per_page=100&page='
  );
  return brokenRows_(articles, checked, function (article, html) {
    var edit = 'https://directscout.recruit.co.jp/contents/wp-admin/post.php?post=' + article.id + '&action=edit';
    return jobsInRds_(html).map(function (job) {
      return {company: job.company, page: titleOf_(article), pageUrl: article.link, job: job.job, jobUrl: job.url, edit: edit};
    });
  });
}

function crawlRag_(checked) {
  var articles = listJson_(
    'https://www.r-agent.com/guide/wp-json/wp/v2/company?status=publish&per_page=100&page='
  );
  return brokenRows_(articles, checked, function (article, html) {
    var edit = 'https://www.r-agent.com/guide/wp-admin/post.php?post=' + article.id + '&action=edit';
    return jobsInRag_(html).map(function (job) {
      return {company: job.company, page: titleOf_(article), pageUrl: article.link, job: job.job, jobUrl: job.url, edit: edit};
    });
  });
}

function brokenRows_(articles, checked, extract) {
  var jobs = [];
  var loaded = {};
  fetchBatches_(articles.map(function (article) { return article.link; }), true).forEach(function (item, index) {
    if (item.code !== 200) return;
    loaded[cleanUrl_(articles[index].link)] = true;
    extract(articles[index], item.body).forEach(function (job) { jobs.push(job); });
  });
  var urls = [];
  var seen = {};
  jobs.forEach(function (job) {
    if (!seen[job.jobUrl]) {
      seen[job.jobUrl] = true;
      urls.push(job.jobUrl);
    }
  });
  var first = {};
  fetchBatches_(urls, false).forEach(function (item) { first[item.url] = item; });
  var redirects = [];
  urls.forEach(function (url) {
    var item = first[url];
    if (item && item.code >= 300 && item.code < 400 && item.location) redirects.push(item.location);
  });
  var second = {};
  fetchBatches_(unique_(redirects), false).forEach(function (item) { second[item.url] = item; });

  var tallies = {};
  jobs.forEach(function (job) {
    var page = cleanUrl_(job.pageUrl);
    if (!tallies[page]) tallies[page] = {alive: 0, broken: 0};
    if (judge_(first[job.jobUrl], second)) tallies[page].broken++;
    else tallies[page].alive++;
  });
  var flags = {};
  Object.keys(tallies).forEach(function (page) {
    flags[page] = tallies[page].alive === 0 ? 'なし' : 'あり';
  });
  Object.keys(loaded).forEach(function (page) {
    if (!flags[page]) flags[page] = 'なし';
  });

  var rows = [];
  jobs.forEach(function (job) {
    var verdict = judge_(first[job.jobUrl], second);
    if (!verdict) return;
    var page = cleanUrl_(job.pageUrl);
    rows.push([
      job.company, job.page, job.pageUrl, job.job, job.jobUrl,
      verdict[0], verdict[1], verdict[2], verdict[3], checked, job.edit,
      '未対応', flags[page] || 'なし', ''
    ]);
  });
  return {rows: rows, flags: flags};
}

function judge_(item, second) {
  if (!item || !item.code) return null;
  if (item.code >= 300 && item.code < 400 && item.location) {
    var target = second[item.location];
    if (target && target.code >= 400) {
      return ['旧URL。遷移先の求人も終了', String(item.code), item.location, String(target.code)];
    }
    return null;
  }
  if (item.code >= 400) return ['求人終了', String(item.code), '', ''];
  return null;
}

function listJson_(prefix) {
  var articles = [];
  for (var page = 1; page <= 10; page++) {
    var response = UrlFetchApp.fetch(prefix + page + '&_fields=id,link,title', {
      muteHttpExceptions: true,
      followRedirects: true
    });
    if (response.getResponseCode() !== 200) break;
    var chunk = JSON.parse(response.getContentText());
    if (!chunk.length) break;
    articles = articles.concat(chunk);
    if (chunk.length < 100) break;
  }
  return articles;
}

function fetchBatches_(urls, follow) {
  var items = [];
  for (var i = 0; i < urls.length; i += 40) {
    var slice = urls.slice(i, i + 40);
    var responses = UrlFetchApp.fetchAll(slice.map(function (url) {
      return {
        url: url,
        muteHttpExceptions: true,
        followRedirects: follow,
        headers: {'User-Agent': 'job-link-check/1.0'}
      };
    }));
    for (var j = 0; j < slice.length; j++) {
      var headers = responses[j].getHeaders();
      var location = headers.Location || headers.location || '';
      if (location && location.indexOf('http') !== 0) {
        location = resolve_(slice[j], location);
      }
      items.push({
        url: slice[j],
        code: responses[j].getResponseCode(),
        location: location,
        body: follow ? responses[j].getContentText() : ''
      });
    }
  }
  return items;
}

function jobsInRds_(html) {
  var parts = html.split(/<div class="job-link-item\b/i);
  var found = [];
  var seen = {};
  for (var i = 1; i < parts.length; i++) {
    var href = parts[i].match(/href="(https:\/\/directscout\.recruit\.co\.jp\/job_descriptions\/\d+)/i);
    if (!href || seen[href[1]]) continue;
    seen[href[1]] = true;
    var overview = parts[i].match(/class="job-link-item__overview">([\s\S]*?)<\/div>/i);
    var company = parts[i].match(/<th>\s*会社名\s*<\/th>\s*<td>([\s\S]*?)<\/td>/i);
    found.push({
      job: overview ? textOf_(overview[1]) : '',
      company: company ? textOf_(company[1]) : '',
      url: href[1]
    });
  }
  if (found.length) return found;
  var all = html.match(/https:\/\/directscout\.recruit\.co\.jp\/job_descriptions\/\d+/g) || [];
  all.forEach(function (url) {
    if (seen[url]) return;
    seen[url] = true;
    found.push({job: '', company: '', url: url});
  });
  return found;
}

function jobsInRag_(html) {
  var re = /<a href="(https:\/\/www\.r-agent\.com\/(?:viewjob|kensaku)\/[^"]+)"[^>]*>[\s\S]*?<p class="rag-recruit-item-company">([\s\S]*?)<\/p>[\s\S]*?<h3 class="rag-recruit-item-title">([\s\S]*?)<\/h3>/gi;
  var found = [];
  var seen = {};
  var match;
  while ((match = re.exec(html))) {
    var url = cleanUrl_(match[1].replace(/&amp;/g, '&'));
    if (seen[url]) continue;
    seen[url] = true;
    found.push({company: textOf_(match[2]), job: textOf_(match[3]), url: url});
  }
  return found;
}

function titleOf_(article) {
  var rendered = article.title && article.title.rendered ? article.title.rendered : '';
  return textOf_(rendered);
}

function textOf_(fragment) {
  var text = String(fragment || '').replace(/<[^>]+>/g, ' ');
  text = text.replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); });
  text = text.replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); });
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolve_(base, location) {
  if (location.indexOf('//') === 0) return 'https:' + location;
  var origin = base.match(/^https?:\/\/[^/]+/);
  if (location.charAt(0) === '/' && origin) return origin[0] + location;
  return location;
}

function checkWpLogin() {
  var keys = ['RDS_WP_USER', 'RDS_WP_APP_PASSWORD', 'RAG_WP_USER', 'RAG_WP_APP_PASSWORD'];
  var props = PropertiesService.getScriptProperties();
  keys.forEach(function (key) {
    console.log(key + ' length ' + String(props.getProperty(key) || '').length);
  });
  console.log('RDS users/me ' + wpStatus_('https://directscout.recruit.co.jp/contents/wp-json/wp/v2/users/me', 'RDS'));
  console.log('RAG users/me ' + wpStatus_('https://www.r-agent.com/guide/wp-json/wp/v2/users/me', 'RAG'));
}

function wpStatus_(url, site) {
  var props = PropertiesService.getScriptProperties();
  var user = props.getProperty(site + '_WP_USER') || '';
  var pass = String(props.getProperty(site + '_WP_APP_PASSWORD') || '').replace(/ /g, '');
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: false,
    headers: {Authorization: 'Basic ' + Utilities.base64Encode(user + ':' + pass)}
  });
  return response.getResponseCode();
}

/**
 * 削除はしない。切れている求人がどのカセットか（記事・ブロック・番号）を一覧にするだけ。
 */
function probeRagRaw() {
  var props = PropertiesService.getScriptProperties();
  var auth = 'Basic ' + Utilities.base64Encode(props.getProperty('RAG_WP_USER') + ':' + String(props.getProperty('RAG_WP_APP_PASSWORD')).replace(/ /g, ''));
  var checked = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var rag = crawlRag_(checked);
  var byPage = {};
  rag.rows.forEach(function (row) {
    var page = cleanUrl_(row[2]);
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push(cleanUrl_(row[4]));
  });
  var total = 0;
  Object.keys(byPage).forEach(function (page) {
    var id = page.split('/').pop();
    var resp = UrlFetchApp.fetch('https://www.r-agent.com/guide/wp-json/wp/v2/company/' + id + '?context=edit&_fields=id,content', {headers: {Authorization: auth}, muteHttpExceptions: true});
    if (resp.getResponseCode() !== 200) {
      console.log('NG 記事 ' + id + ' HTTP ' + resp.getResponseCode());
      return;
    }
    var raw = JSON.parse(resp.getContentText()).content.raw || '';
    var re = /<!-- wp:rag-blocks\/recruit ([\s\S]*?) \/-->/g;
    var match;
    var block = 0;
    var found = 0;
    while ((match = re.exec(raw))) {
      block++;
      var data = (JSON.parse(match[1]).data) || {};
      Object.keys(data).forEach(function (key) {
        var m = key.match(/^rag-blocks-recruit-items_(\d+)_rag-blocks-recruit-item-url$/);
        if (!m) return;
        var url = cleanUrl_(data[key]);
        if (byPage[page].indexOf(url) >= 0) {
          found++;
          total++;
          console.log('対象 記事' + id + ' ブロック' + block + ' 番号' + m[1] + ' ' + url);
        }
      });
    }
    console.log('記事' + id + ' 切れ求人 ' + byPage[page].length + ' / 対象カセット行 ' + found + ' / ブロック ' + block);
  });
  console.log('合計 記事 ' + Object.keys(byPage).length + ' / 切れ求人 ' + rag.rows.length + ' / 対象行 ' + total);
}

function unique_(values) {
  var seen = {};
  return values.filter(function (value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}
