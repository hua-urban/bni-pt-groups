// GitHub Actions 排程用：抓 GAS 唯讀 doGet 最新名單，驗證合法後落地成 repo 根目錄的 data.json。
// 目的：讓 index.html 開頁優先讀這份靜態快照（近乎瞬間），不用每次都等 GAS 2~3 秒。
//
// 驗證失敗（HTTP 非 2xx／JSON 格式錯誤／ok !== true／members 為空）一律丟例外、
// process.exit(1) 結束，不觸碰既有 data.json，避免把壞資料 commit 上去。
//
// 2026-08-19 加上重試：Google Apps Script 的 /exec 會 302 導到 script.googleusercontent.com，
// Google 端偶發回 404（實測 30 次排程中 6 次，約 20%），但同一個 URL 手動打是通的。
// 單次 fetch 失敗就整個 job red，等於每天寄一堆假失敗信。改成最多 4 次、間隔遞增；
// 全部失敗才視為真的壞掉並 exit 1。
'use strict';

const fs = require('fs');
const path = require('path');

const GAS_URL = process.env.GAS_URL;
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'data.json');

const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = [3000, 8000, 20000]; // 第 1/2/3 次失敗後各等多久
const FETCH_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 抓一次並驗證。任何一關不過就丟例外，交給外層決定要不要重試。
async function fetchOnce() {
  // 帶時間戳當 cache-busting query，避免任何中介層快取住舊回應。
  const url = GAS_URL + '?t=' + Date.now();
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error('GAS 回應非 2xx：HTTP ' + res.status);
  }

  const data = await res.json();

  if (!data || data.ok !== true) {
    throw new Error('GAS 回應 ok !== true 或格式不合法');
  }
  if (!Array.isArray(data.members) || data.members.length === 0) {
    throw new Error('GAS 回應 members 為空或不是陣列');
  }
  if (!Array.isArray(data.groups)) {
    throw new Error('GAS 回應 groups 不是陣列');
  }

  return data;
}

async function fetchWithRetry() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await fetchOnce();
      if (attempt > 1) {
        console.log('第 ' + attempt + ' 次嘗試成功');
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        const wait = RETRY_DELAY_MS[attempt - 1];
        console.warn('第 ' + attempt + '/' + MAX_ATTEMPTS + ' 次嘗試失敗（' + err.message + '），' + (wait / 1000) + ' 秒後重試');
        await sleep(wait);
      }
    }
  }
  throw new Error('連續 ' + MAX_ATTEMPTS + ' 次都失敗，最後一次：' + lastErr.message);
}

async function main() {
  if (!GAS_URL) {
    throw new Error('缺少環境變數 GAS_URL');
  }

  const data = await fetchWithRetry();

  // 只落地 members/groups，刻意不寫入 generatedAt 這類每次呼叫必變的欄位，
  // 讓後續 `git diff --quiet` 能準確反映「名單內容有沒有真的變」，
  // 避免每 10 分鐘都因時間戳不同而產生空轉 commit。
  const snapshot = { members: data.members, groups: data.groups };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log('已寫入 data.json：members=' + data.members.length + ' groups=' + data.groups.length);
}

main().catch(function (err) {
  console.error('同步失敗，不動 data.json：', err.message);
  process.exit(1);
});
