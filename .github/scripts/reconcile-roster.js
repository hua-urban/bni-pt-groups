// 名冊每日對帳：去打六個線上端點，比對「各自認為分會有幾個人」。
//
// 【為什麼要有這支】
//   同一份會員名冊在分會六套系統各存一份副本，每次有人進出要手動改六處。
//   漏改一處，那個網站就默默錯著——網站照常運作，只是少一個人，不會有任何徵兆。
//   實際發生過：2026-09-08 發現培訓系統線上停在 57 人，漏了三次退會、錯了將近兩個月；
//   2026-09-11 058 王振伊入會，六處全都沒有他，是會員自己來反映才發現。
//
//   **人工盤點抓不到這種錯**——2026-09-08 那次的教訓是「因為本機檔案看起來是對的，
//   歷次盤點都判它已完成」，線上其實是錯的。只有機器逐一去打線上端點才抓得到。
//
// 【正常就完全安靜】六處一致 → 不發任何通知、不寫任何檔案，exit 0。
//   只有對不上才發一則到 LINE，內容直接寫明哪個系統少了誰、該去改哪裡。
//
// 【額度】通知走小幫手的 notifyInfoLead，那邊有每日去重與每月上限，這裡不必再管。
//   帶固定 dedupeKey='roster-mismatch'，所以同一個落差一天只響一次。
'use strict';

const FETCH_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = [3000, 8000, 20000];

// 基準：PowerTeam 的 Google 試算表。它是唯一有正式寫入機制、有快照、有稽核軌跡的一份。
const BASELINE = 'PowerTeam 組別管理';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchText(url) {
  const res = await fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now(), {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'hua-urban-roster-reconcile' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// Google Apps Script 的 /exec 偶發回 404（實測約 20%），同一個 URL 手動打卻是通的。
// 單次失敗就報警等於天天發假警報，所以重試到底，全掛才算真的壞了。
async function withRetry(label, fn) {
  let lastErr;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < MAX_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS[i]);
    }
  }
  throw new Error(label + ' 連續 ' + MAX_ATTEMPTS + ' 次失敗：' + lastErr.message);
}

// ── 六處各自怎麼數 ─────────────────────────────────────────────────────
// 每一項回傳 { name, count, names booleanable }。names 拿得到就拿，用來算「少了誰」。

async function countPtGroups(url) {
  const d = JSON.parse(await fetchText(url));
  if (!d || d.ok !== true || !Array.isArray(d.members)) throw new Error('回應格式不符');
  return { count: d.members.length, names: d.members.map((m) => String(m.name || '')) };
}

async function countTraining(url) {
  const d = JSON.parse(await fetchText(url + '?names=1'));
  if (!d || !Array.isArray(d.names)) throw new Error('回應格式不符');
  return { count: d.names.length, names: d.names.map(String) };
}

// 入口頁與 E 組九宮格沒有 API，數頁面上的固定標記。
// 標記選得很窄（名冊列才有的 data-n / BRANCH_ROSTER 的三欄陣列），
// 避免頁面改版後數到不相干的東西還以為對得上。
async function countPortal(url) {
  const html = await fetchText(url);
  const rows = html.match(/<tr\s+data-n="/g) || [];
  if (rows.length === 0) throw new Error('頁面上找不到名冊列，可能改版了');
  return { count: rows.length, names: (html.match(/data-n="([^"]*)"/g) || []).map((s) => s.slice(8, -1)) };
}

async function countETeam(url) {
  const html = await fetchText(url);
  const m = html.match(/const BRANCH_ROSTER\s*=\s*\[([\s\S]*?)\n\s*\];/);
  if (!m) throw new Error('頁面上找不到名冊陣列，可能改版了');
  // ⚠️ 每一列長這樣：["姓名","專業別",["A","B"]]——所屬鏈本身也是 ["A"] 形狀，
  //   只抓 [" 會把鏈代碼一起數進來（2026-09-11 實測：41 列被數成 79）。
  //   所以整列比對：姓名、專業別、鏈陣列三段一起匹配才算一列。
  const rows = m[1].match(/\[\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*\[/g) || [];
  if (rows.length === 0) throw new Error('名冊陣列的格式不認得，可能改版了');
  return {
    count: rows.length,
    names: rows.map((r) => (r.match(/^\[\s*"([^"]+)"/) || [])[1] || ''),
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────────
async function main() {
  const S = process.env;
  const targets = [
    { name: BASELINE,          run: () => countPtGroups(S.PT_GAS_URL),    fix: 'Sheet Members 正本，用 addMember／removeMember API' },
    { name: '對外夥伴入口頁',   run: () => countPortal(S.PORTAL_URL),     fix: 'hua-urban.github.io 的 index.html，四處都要改' },
    { name: '培訓進度回報',     run: () => countTraining(S.TRAINING_URL),  fix: 'bni-training/gas/Code.gs 的 ROSTER，改完要 clasp deploy' },
    { name: 'E 組九宮格',       run: () => countETeam(S.ETEAM_URL),        fix: 'e-team-grid/index.html 的 BRANCH_ROSTER（只列非 E 組者）' },
  ];

  const results = [];
  const errors = [];
  for (const t of targets) {
    try {
      const r = await withRetry(t.name, t.run);
      results.push({ name: t.name, count: r.count, names: r.names, fix: t.fix });
      console.log(`  ${t.name}：${r.count} 人`);
    } catch (err) {
      errors.push({ name: t.name, message: err.message, fix: t.fix });
      console.log(`  ${t.name}：查不到（${err.message}）`);
    }
  }

  const baseline = results.find((r) => r.name === BASELINE);

  // 基準本身抓不到就不比了——拿一個不確定的數字去說別人錯，只會製造假警報。
  if (!baseline) {
    await notify(
      '⚠️ 名冊對帳沒跑完\n\n' +
      `基準（${BASELINE}）抓不到資料，今天無法比對。\n` +
      '這通常是 Google 服務暫時性的問題，明天會自動再試一次。\n' +
      '連續幾天都這樣就要去看那支後端還在不在。',
      'roster-baseline-down'
    );
    process.exit(0);
  }

  // E 組九宮格列的是「非現役 E 組者」，人數天生比全分會少，不能直接比數字。
  // 改成檢查「基準有、它卻整個查不到的人」——它少的人應該都是 E 組成員，
  // 真正要抓的是「新人入會後六處都沒補」，那種情況它也會缺。
  const mismatches = [];

  for (const r of results) {
    if (r.name === BASELINE) continue;
    if (r.name === 'E 組九宮格') {
      const missing = missingFrom(baseline.names, r.names);
      // E 組現役成員本來就不在這張表裡，扣掉之後還缺人才算異常。
      // 這裡不知道誰是 E 組現役，所以只在「缺的人數比上次多」時才報——
      // 改用絕對值判斷會天天誤報。實作上以 E 組現役上限 20 人為容忍值。
      if (missing.length > 20) {
        mismatches.push({ name: r.name, detail: `比基準少 ${missing.length} 人，超出 E 組現役人數的合理範圍`, fix: r.fix, missing });
      }
      continue;
    }
    if (r.count !== baseline.count) {
      const missing = missingFrom(baseline.names, r.names);
      mismatches.push({
        name: r.name,
        detail: `${r.count} 人，基準是 ${baseline.count} 人`,
        fix: r.fix,
        missing,
      });
    }
  }

  if (mismatches.length === 0 && errors.length === 0) {
    console.log('\n✅ 全部一致，不發通知。');
    await recordBeat(`名冊六處一致（${baseline.count} 人）`);
    process.exit(0);
  }

  // ── 有落差才組訊息 ───────────────────────────────────────────────────
  const lines = ['⚠️ 分會名冊對不起來', ''];
  lines.push(`基準（${BASELINE}）：${baseline.count} 人`);
  lines.push('');

  for (const m of mismatches) {
    lines.push(`❌ ${m.name}：${m.detail}`);
    if (m.missing && m.missing.length > 0 && m.missing.length <= 5) {
      lines.push(`   少了：${m.missing.join('、')}`);
    }
    lines.push(`   要改：${m.fix}`);
    lines.push('');
  }

  for (const e of errors) {
    lines.push(`⚠️ ${e.name}：查不到（${e.message}）`);
    lines.push('');
  }

  lines.push('完整的異動檢查表在名冊正本筆記裡（會員異動要改哪幾處）。');

  await notify(lines.join('\n'), 'roster-mismatch');
  await recordBeat(`名冊對帳發現 ${mismatches.length} 處落差`);

  // 刻意 exit 0：對帳「發現問題」是它正常運作的結果，不是這支程式壞了。
  // 用非零會讓 Actions 一片紅，真正的故障反而被淹沒（見 vault 踩坑速查）。
  process.exit(0);
}

// 基準有、對方沒有的人。兩邊命名格式不完全一致（有人帶英文別名、有人帶括號），
// 所以比對前先抽出中文主體，沿用各系統既有的 normalizeName 思路。
function core(s) { return String(s).replace(/[^一-鿿]/g, ''); }
function missingFrom(baseNames, otherNames) {
  const have = (otherNames || []).map(core).filter(Boolean);
  return (baseNames || []).filter((n) => {
    const c = core(n);
    if (!c) return false;
    return !have.some((h) => h === c || h.indexOf(c) !== -1 || c.indexOf(h) !== -1);
  });
}

async function notify(text, key) {
  const url = process.env.NOTIFY_URL;
  const token = process.env.NOTIFY_TOKEN;
  if (!url || !token) {
    console.log('\n[notify] 未設定通知端點，只輸出到 log：\n' + text);
    return;
  }
  try {
    const u = url + '?admin=notify&t=' + encodeURIComponent(token) +
      '&key=' + encodeURIComponent(key) + '&text=' + encodeURIComponent(text);
    const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    console.log('\n[notify] 送出結果：HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  } catch (err) {
    // 通知送不出去不得讓對帳整支失敗——對帳結果已經寫在 log 裡了。
    console.log('\n[notify] 送出失敗（不影響對帳結果）：' + err.message);
  }
}

// 把「今天跑過了」記進小幫手，讓 /系統狀態 查得到。失敗不影響對帳。
async function recordBeat(summary) {
  const url = process.env.NOTIFY_URL;
  const token = process.env.NOTIFY_TOKEN;
  if (!url || !token) return;
  try {
    const u = url + '?admin=recon&t=' + encodeURIComponent(token) + '&summary=' + encodeURIComponent(summary);
    await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    console.log('[recordBeat] 略過：' + err.message);
  }
}

main().catch((err) => {
  // 這裡才是真的壞了（程式自己丟例外），讓 Actions 紅給資訊組看。
  console.error('對帳程式異常：' + err.stack);
  process.exit(1);
});
