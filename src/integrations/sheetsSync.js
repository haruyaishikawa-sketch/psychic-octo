'use strict';

/**
 * Google Sheets 連携モジュール
 *
 * 認証情報が .env に設定されていない場合は全関数をno-opにして
 * メイン処理には一切影響を与えない。
 */

const { google } = require('googleapis');
const { getDb }  = require('../db/database');

// ────────────────────────────────────────────────────────────────
// シート名 / ヘッダー定義
// ────────────────────────────────────────────────────────────────
const SHEET = {
  INVENTORY : '在庫台帳',
  ORDERS    : '発注記録',
  INVOICES  : '請求管理',
  STOCKTAKE : '棚卸し履歴',
};

const HEADERS = {
  [SHEET.INVENTORY] : ['品目ID', '品名', '規格', '単位', '現在庫数', '単価', '発注点', '最終更新日時'],
  [SHEET.ORDERS]    : ['発注ID', '発注日時', '品名', '数量', '仕入先', '単価', '合計金額', '状態', '承認日時'],
  [SHEET.INVOICES]  : ['請求ID', '請求書番号', '請求日', '顧客名', '品目一覧', '合計額', '消費税', '入金状態', '入金日'],
  [SHEET.STOCKTAKE] : ['実施日', '品目名', 'システム在庫数', '実数', '差分'],
};

// ヘッダー背景色（深緑）
const HEADER_COLOR = { red: 0.17, green: 0.37, blue: 0.17 };
// 在庫アラート背景色（薄赤）
const ALERT_COLOR  = { red: 1.0,  green: 0.85, blue: 0.85 };
// 通常行背景色（白）
const NORMAL_COLOR = { red: 1.0,  green: 1.0,  blue: 1.0  };

// ────────────────────────────────────────────────────────────────
// 状態管理
// ────────────────────────────────────────────────────────────────
let sheetsClient = null;
let spreadsheetId = null;
let sheetIdCache = {}; // { sheetName: numericSheetId }
let initialized  = false;

function isReady() { return initialized && sheetsClient && spreadsheetId; }

// ────────────────────────────────────────────────────────────────
// 初期化
// ────────────────────────────────────────────────────────────────

/** 認証・接続・シート初期化 */
async function initSheets() {
  const email  = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!email || !rawKey || !spreadsheetId) {
    console.log('[Sheets] 認証情報未設定 — スキップ');
    return false;
  }

  try {
    const auth = new google.auth.JWT({
      email,
      key  : rawKey.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    await auth.authorize(); // 接続確認

    sheetsClient = google.sheets({ version: 'v4', auth });
    await ensureSheets();
    initialized = true;
    console.log('[Sheets] ✅ Google Sheets 接続完了');
    return true;
  } catch (err) {
    console.error('[Sheets] ❌ 初期化失敗:', err.message);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// シート存在確認・作成・ヘッダー初期化
// ────────────────────────────────────────────────────────────────

async function ensureSheets() {
  // 既存シート一覧を取得
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const existingSheets = meta.data.sheets.map(s => ({
    title: s.properties.title,
    id   : s.properties.sheetId,
  }));

  // sheetIdCache をリセット
  sheetIdCache = {};
  existingSheets.forEach(s => { sheetIdCache[s.title] = s.id; });

  // 存在しないシートを作成
  const missing = Object.values(SHEET).filter(
    name => !existingSheets.find(s => s.title === name)
  );

  if (missing.length > 0) {
    const addRequests = missing.map(title => ({
      addSheet: { properties: { title } },
    }));
    const res = await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: addRequests },
    });
    // 新しく作成されたシートの ID をキャッシュ
    res.data.replies.forEach((reply, i) => {
      if (reply.addSheet) {
        sheetIdCache[missing[i]] = reply.addSheet.properties.sheetId;
      }
    });
  }

  // 各シートのヘッダーを確認・書き込み
  for (const sheetName of Object.values(SHEET)) {
    const range = `${sheetName}!A1:Z1`;
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
    const existing = res.data.values?.[0];

    if (!existing || existing.length === 0) {
      // ヘッダー書き込み
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [HEADERS[sheetName]] },
      });
      // ヘッダー書式設定（太字・背景色）
      await formatHeaderRow(sheetIdCache[sheetName]);
    }
  }
}

/** ヘッダー行を太字・緑背景に設定 */
async function formatHeaderRow(sheetId) {
  const colCount = 12;
  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount },
          cell: {
            userEnteredFormat: {
              backgroundColor: HEADER_COLOR,
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      }],
    },
  });
}

// ────────────────────────────────────────────────────────────────
// 行検索ヘルパー
// ────────────────────────────────────────────────────────────────

/**
 * シートのキー列（colIndex=0 が列A）で keyValue を検索
 * @returns {number} 1-indexed の行番号。見つからなければ -1
 */
async function findRow(sheetName, colIndex, keyValue) {
  const colLetter = String.fromCharCode(65 + colIndex); // A, B, C...
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!${colLetter}:${colLetter}`,
  });
  const rows = res.data.values || [];
  const idx  = rows.findIndex(r => String(r[0]) === String(keyValue));
  return idx === -1 ? -1 : idx + 1; // 1-indexed
}

/** 行の値を更新（values.update） */
async function updateRow(sheetName, rowNum, values) {
  const endCol = String.fromCharCode(65 + values.length - 1);
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A${rowNum}:${endCol}${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

/** 末尾に行を追加（values.append） */
async function appendRow(sheetName, values) {
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

/** 指定行の背景色を設定 */
async function setRowBackground(sheetId, rowIndex0, color, colCount) {
  const cellValues = Array(colCount).fill({
    userEnteredFormat: { backgroundColor: color },
  });
  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateCells: {
          range: {
            sheetId,
            startRowIndex: rowIndex0,
            endRowIndex  : rowIndex0 + 1,
            startColumnIndex: 0,
            endColumnIndex  : colCount,
          },
          rows  : [{ values: cellValues }],
          fields: 'userEnteredFormat.backgroundColor',
        },
      }],
    },
  });
}

/** 現在日時を「YYYY/MM/DD HH:mm」形式で返す */
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} `
       + `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ────────────────────────────────────────────────────────────────
// 公開 API — シート1: 在庫台帳
// ────────────────────────────────────────────────────────────────

/**
 * 品目の在庫行を更新（存在しなければ追加）
 * 在庫が発注点以下なら背景色を薄赤にする
 */
async function syncInventory(productId) {
  if (!isReady()) return;
  const db      = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(productId));
  if (!product) return;

  const row = [
    product.id,
    product.name,
    product.spec,
    product.unit,
    product.stock,
    product.unit_price,
    product.reorder_point,
    nowStr(),
  ];

  let rowNum = await findRow(SHEET.INVENTORY, 0, product.id);
  if (rowNum === -1 || rowNum === 1) { // 1はヘッダー行なのでスキップ判定
    if (rowNum === 1) {
      // ヘッダー行と一致（IDが "品目ID" の文字列に一致してしまう場合は無視）
      rowNum = -1;
    }
  }

  if (rowNum <= 1) {
    // 新規追加
    await appendRow(SHEET.INVENTORY, row);
    // 追加した行番号を再取得
    rowNum = await findRow(SHEET.INVENTORY, 0, product.id);
  } else {
    await updateRow(SHEET.INVENTORY, rowNum, row);
  }

  // 在庫アラート背景色
  if (rowNum > 1) {
    const isAlert = product.stock <= product.reorder_point;
    await setRowBackground(
      sheetIdCache[SHEET.INVENTORY],
      rowNum - 1,  // 0-indexed
      isAlert ? ALERT_COLOR : NORMAL_COLOR,
      HEADERS[SHEET.INVENTORY].length
    );
  }
}

// ────────────────────────────────────────────────────────────────
// 公開 API — シート2: 発注記録
// ────────────────────────────────────────────────────────────────

/** 発注レコードを末尾に追加 */
async function appendOrder(orderData) {
  if (!isReady()) return;
  const row = [
    orderData.id,
    orderData.created_at || nowStr(),
    orderData.product_name,
    orderData.quantity,
    orderData.supplier_name || '未定',
    orderData.unit_price    || '',
    orderData.total_amount  || '',
    orderData.status        || 'pending',
    '', // 承認日時（初期空）
  ];
  await appendRow(SHEET.ORDERS, row);
}

/** 発注の状態列と承認日時を更新 */
async function updateOrderStatus(orderId, status) {
  if (!isReady()) return;
  const rowNum = await findRow(SHEET.ORDERS, 0, orderId);
  if (rowNum <= 1) return;

  const statusCol = String.fromCharCode(65 + 7); // H列 (index 7)
  const dateCol   = String.fromCharCode(65 + 8); // I列 (index 8)

  await sheetsClient.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${SHEET.ORDERS}!${statusCol}${rowNum}`, values: [[status]] },
        { range: `${SHEET.ORDERS}!${dateCol}${rowNum}`,   values: [[nowStr()]] },
      ],
    },
  });
}

// ────────────────────────────────────────────────────────────────
// 公開 API — シート3: 請求管理
// ────────────────────────────────────────────────────────────────

/** 請求書レコードを末尾に追加 */
async function appendInvoice(invoiceData) {
  if (!isReady()) return;
  let itemSummary = '';
  try {
    const items = typeof invoiceData.items === 'string'
      ? JSON.parse(invoiceData.items) : invoiceData.items;
    itemSummary = items.map(i => `${i.product_name}×${i.quantity}`).join(' / ');
  } catch { itemSummary = '—'; }

  const row = [
    invoiceData.id,
    invoiceData.invoice_number || '—',
    invoiceData.created_at ? invoiceData.created_at.slice(0, 10) : nowStr().slice(0, 10),
    invoiceData.customer_name,
    itemSummary,
    invoiceData.total_amount,
    invoiceData.tax_amount || 0,
    invoiceData.status === 'paid' ? '入金済' : '未入金',
    invoiceData.status === 'paid' ? nowStr() : '',
  ];
  await appendRow(SHEET.INVOICES, row);
}

/** 入金状態を更新 */
async function updateInvoicePayment(invoiceId) {
  if (!isReady()) return;
  const rowNum = await findRow(SHEET.INVOICES, 0, invoiceId);
  if (rowNum <= 1) return;

  const statusCol = String.fromCharCode(65 + 7); // H列
  const dateCol   = String.fromCharCode(65 + 8); // I列

  await sheetsClient.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${SHEET.INVOICES}!${statusCol}${rowNum}`, values: [['入金済']] },
        { range: `${SHEET.INVOICES}!${dateCol}${rowNum}`,   values: [[nowStr()]] },
      ],
    },
  });
}

// ────────────────────────────────────────────────────────────────
// 公開 API — シート4: 棚卸し履歴
// ────────────────────────────────────────────────────────────────

/**
 * 棚卸し結果を追記
 * @param {Array} adjustments - [{product_name, system_stock, actual_stock, diff}]
 */
async function appendStocktake(adjustments) {
  if (!isReady() || !adjustments?.length) return;
  const dateStr = nowStr().slice(0, 10);
  for (const adj of adjustments) {
    await appendRow(SHEET.STOCKTAKE, [
      dateStr,
      adj.product_name,
      adj.systemStock  ?? adj.system_stock,
      adj.actualStock  ?? adj.actual_stock,
      adj.diff,
    ]);
  }
}

// ────────────────────────────────────────────────────────────────
// ヘルパー: バックグラウンド実行（LINE 返信をブロックしない）
// ────────────────────────────────────────────────────────────────

/**
 * 関数を setImmediate で非同期実行し、エラーはログのみ
 */
function runAsync(fn, ...args) {
  setImmediate(async () => {
    try { await fn(...args); }
    catch (err) { console.error(`[Sheets] 非同期エラー (${fn.name}):`, err.message); }
  });
}

module.exports = {
  initSheets,
  syncInventory,
  appendOrder,
  updateOrderStatus,
  appendInvoice,
  updateInvoicePayment,
  appendStocktake,
  runAsync,
};
