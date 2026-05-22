'use strict';

/**
 * Gmail 連携モジュール（nodemailer + OAuth2）
 *
 * 認証情報が .env に設定されていない場合は全関数をno-opにして
 * メイン処理には一切影響を与えない。
 */

const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const { getDb }  = require('../db/database');

// ────────────────────────────────────────────────────────────────
// 状態管理
// ────────────────────────────────────────────────────────────────
let transporter = null;
let fromAddress = null;
let initialized = false;

function isReady() { return initialized && transporter; }

// ────────────────────────────────────────────────────────────────
// 初期化
// ────────────────────────────────────────────────────────────────

/** nodemailer OAuth2 トランスポーターを初期化 */
async function initGmail() {
  fromAddress              = process.env.GMAIL_USER;
  const clientId           = process.env.GMAIL_CLIENT_ID;
  const clientSecret       = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken       = process.env.GMAIL_REFRESH_TOKEN;

  if (!fromAddress || !clientId || !clientSecret || !refreshToken) {
    console.log('[Gmail] 認証情報未設定 — スキップ');
    return false;
  }

  try {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type         : 'OAuth2',
        user         : fromAddress,
        clientId,
        clientSecret,
        refreshToken,
      },
    });
    // 接続確認
    await transporter.verify();
    initialized = true;
    console.log('[Gmail] ✅ Gmail 接続完了');
    return true;
  } catch (err) {
    console.error('[Gmail] ❌ 初期化失敗:', err.message);
    transporter = null;
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// ユーティリティ
// ────────────────────────────────────────────────────────────────

/** 金額を「¥1,234,567」形式にフォーマット */
function fmtMoney(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }

/** 日付を「YYYY年MM月DD日」形式にフォーマット */
function jpDate(d = new Date()) {
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}

/** メール送信の共通ラッパー */
async function sendMail(opts) {
  if (!isReady()) {
    console.log('[Gmail] 未初期化 — メール送信スキップ:', opts.subject);
    return false;
  }
  try {
    await transporter.sendMail({ from: fromAddress, ...opts });
    console.log('[Gmail] ✅ 送信完了:', opts.subject, '→', opts.to);
    return true;
  } catch (err) {
    console.error('[Gmail] ❌ 送信失敗:', opts.subject, err.message);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// 公開 API
// ────────────────────────────────────────────────────────────────

/**
 * 請求書PDFをメール添付で送信
 * @param {number|string} customerId
 * @param {string} pdfPath - PDFファイルの絶対パス
 * @param {object} invoice - invoices テーブルのレコード
 */
async function sendInvoiceEmail(customerId, pdfPath, invoice) {
  const db       = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customerId));
  if (!customer) { console.warn('[Gmail] 顧客が見つかりません:', customerId); return false; }
  if (!customer.email) { console.warn('[Gmail] 顧客メール未登録:', customer.company_name); return false; }

  const companyName = process.env.COMPANY_NAME || '材木店';
  const month       = invoice?.billing_month || '';
  const subject     = `【請求書】${month}分 from ${companyName}`;

  const html = `
<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;color:#333;max-width:600px;margin:0 auto">
<h2 style="color:#1B3A2D;border-bottom:2px solid #2C7A4B;padding-bottom:8px">ご請求書送付のお知らせ</h2>
<p>${customer.company_name} ご担当者様</p>
<p>いつもお世話になっております。<br>
下記の通りご請求書をお送りいたします。</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr style="background:#EDF7ED">
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold;width:130px">請求書番号</td>
    <td style="padding:8px 12px;border:1px solid #ccc">${invoice?.invoice_number || '—'}</td>
  </tr>
  <tr>
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold">請求対象月</td>
    <td style="padding:8px 12px;border:1px solid #ccc">${month}</td>
  </tr>
  <tr style="background:#EDF7ED">
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold">ご請求金額</td>
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold;color:#1B3A2D;font-size:1.1em">${fmtMoney(invoice?.total_amount || 0)}（税込）</td>
  </tr>
  <tr>
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold">支払期限</td>
    <td style="padding:8px 12px;border:1px solid #ccc;color:#DC2626">${invoice?.due_date || '翌月末'}</td>
  </tr>
</table>
<p>添付のPDFをご確認いただき、期日までにお振込みいただきますようお願いいたします。</p>
<p style="color:#888;font-size:0.85em">振込先：${process.env.COMPANY_BANK || '〇〇銀行 △△支店 普通 1234567'}</p>
<hr style="border:none;border-top:1px solid #eee;margin:24px 0">
<p style="color:#888;font-size:0.85em">${companyName}<br>
${process.env.COMPANY_ADDRESS || ''}<br>
TEL: ${process.env.COMPANY_TEL || ''}</p>
</body></html>`;

  const attachments = fs.existsSync(pdfPath)
    ? [{ filename: path.basename(pdfPath), path: pdfPath, contentType: 'application/pdf' }]
    : [];

  return sendMail({ to: customer.email, subject, html, attachments });
}

/**
 * 発注確認メールを仕入先に送信
 * @param {number|string} supplierId
 * @param {object} orderData - orders テーブルのレコード
 */
async function sendOrderConfirmEmail(supplierId, orderData) {
  const db       = getDb();
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(supplierId));
  if (!supplier)        { console.warn('[Gmail] 仕入先が見つかりません:', supplierId); return false; }
  if (!supplier.email)  { console.warn('[Gmail] 仕入先メール未登録:', supplier.company_name);  return false; }

  const companyName = process.env.COMPANY_NAME || '材木店';
  const subject     = `【発注確認】${orderData.product_name} ${orderData.quantity}${orderData.unit || ''}`;

  const html = `
<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;color:#333;max-width:600px;margin:0 auto">
<h2 style="color:#1D4ED8;border-bottom:2px solid #1D4ED8;padding-bottom:8px">発注確認書</h2>
<p>${supplier.company_name} ご担当者様</p>
<p>いつもお世話になっております。<br>
以下の通り発注をいたしますので、ご確認をお願いいたします。</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr style="background:#EBF5FB">
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold;width:130px">発注番号</td>
    <td style="padding:8px 12px;border:1px solid #ccc">#${orderData.id}</td>
  </tr>
  <tr>
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold">品名</td>
    <td style="padding:8px 12px;border:1px solid #ccc">${orderData.product_name}</td>
  </tr>
  <tr style="background:#EBF5FB">
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold">数量</td>
    <td style="padding:8px 12px;border:1px solid #ccc">${orderData.quantity}</td>
  </tr>
  <tr>
    <td style="padding:8px 12px;border:1px solid #ccc;font-weight:bold">発注日</td>
    <td style="padding:8px 12px;border:1px solid #ccc">${jpDate()}</td>
  </tr>
</table>
<p>ご不明な点はお問い合わせください。どうぞよろしくお願いいたします。</p>
<hr style="border:none;border-top:1px solid #eee;margin:24px 0">
<p style="color:#888;font-size:0.85em">${companyName}<br>
${process.env.COMPANY_ADDRESS || ''} / TEL: ${process.env.COMPANY_TEL || ''}</p>
</body></html>`;

  return sendMail({ to: supplier.email, subject, html });
}

/**
 * 在庫アラートメールを管理者に送信
 * @param {Array} products - 発注点以下の品目リスト
 */
async function sendStockAlertEmail(products) {
  if (!products?.length) return false;
  if (!fromAddress) return false;

  const subject = `【在庫アラート】発注点以下の品目が ${products.length} 件あります`;

  const rows = products.map(p =>
    `<tr><td style="padding:6px 12px;border:1px solid #ccc">${p.name}</td>
     <td style="padding:6px 12px;border:1px solid #ccc">${p.spec}</td>
     <td style="padding:6px 12px;border:1px solid #ccc;color:#DC2626;font-weight:bold">${p.stock} ${p.unit}</td>
     <td style="padding:6px 12px;border:1px solid #ccc">${p.reorder_point} ${p.unit}</td></tr>`
  ).join('');

  const html = `
<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;color:#333;max-width:600px;margin:0 auto">
<h2 style="color:#DC2626;border-bottom:2px solid #DC2626;padding-bottom:8px">⚠️ 在庫アラート</h2>
<p>以下の品目が発注点以下になっています。発注をご検討ください。</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <thead>
    <tr style="background:#FEE2E2">
      <th style="padding:8px 12px;border:1px solid #ccc;text-align:left">品名</th>
      <th style="padding:8px 12px;border:1px solid #ccc;text-align:left">規格</th>
      <th style="padding:8px 12px;border:1px solid #ccc;text-align:left">現在庫</th>
      <th style="padding:8px 12px;border:1px solid #ccc;text-align:left">発注点</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<p style="color:#888;font-size:0.85em">送信元: ${process.env.COMPANY_NAME || '材木店'} 在庫管理システム</p>
</body></html>`;

  return sendMail({ to: fromAddress, subject, html });
}

/**
 * 月次レポートメールを管理者に送信
 */
async function sendMonthlyReportEmail() {
  if (!fromAddress) return false;
  const db = getDb();

  const now        = new Date();
  const prevMonth  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthStr   = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth()+1).padStart(2,'0')}`;
  const monthLabel = `${prevMonth.getFullYear()}年${prevMonth.getMonth()+1}月`;

  // 前月の集計
  const orderCount    = Number(db.prepare("SELECT COUNT(*) AS cnt FROM orders WHERE created_at LIKE ?").get(`${monthStr}%`).cnt);
  const invoiceTotal  = Number(db.prepare("SELECT COALESCE(SUM(total_amount),0) AS s FROM invoices WHERE billing_month = ?").get(monthStr).s);
  const paidTotal     = Number(db.prepare("SELECT COALESCE(SUM(total_amount),0) AS s FROM invoices WHERE billing_month = ? AND status='paid'").get(monthStr).s);
  const stockAdjCount = Number(db.prepare("SELECT COUNT(*) AS cnt FROM inventory_adjustments WHERE adjusted_at LIKE ?").get(`${monthStr}%`).cnt);
  const alertCount    = Number(db.prepare("SELECT COUNT(*) AS cnt FROM products WHERE stock <= reorder_point").get().cnt);

  const subject = `【月次レポート】${monthLabel}分 — ${process.env.COMPANY_NAME || '材木店'}`;

  const html = `
<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;color:#333;max-width:600px;margin:0 auto">
<h2 style="color:#1B3A2D;border-bottom:2px solid #2C7A4B;padding-bottom:8px">📊 月次業務レポート</h2>
<p><strong>${monthLabel} の業務サマリー</strong></p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr style="background:#EDF7ED">
    <td style="padding:10px 16px;border:1px solid #ccc;font-weight:bold">発注件数</td>
    <td style="padding:10px 16px;border:1px solid #ccc;font-size:1.2em"><strong>${orderCount} 件</strong></td>
  </tr>
  <tr>
    <td style="padding:10px 16px;border:1px solid #ccc;font-weight:bold">請求合計額</td>
    <td style="padding:10px 16px;border:1px solid #ccc;font-size:1.2em"><strong>${fmtMoney(invoiceTotal)}</strong></td>
  </tr>
  <tr style="background:#EDF7ED">
    <td style="padding:10px 16px;border:1px solid #ccc;font-weight:bold">入金済額</td>
    <td style="padding:10px 16px;border:1px solid #ccc;font-size:1.2em;color:#1B3A2D"><strong>${fmtMoney(paidTotal)}</strong></td>
  </tr>
  <tr>
    <td style="padding:10px 16px;border:1px solid #ccc;font-weight:bold">棚卸し調整件数</td>
    <td style="padding:10px 16px;border:1px solid #ccc"><strong>${stockAdjCount} 件</strong></td>
  </tr>
  <tr style="background:${alertCount > 0 ? '#FEF2F2' : '#EDF7ED'}">
    <td style="padding:10px 16px;border:1px solid #ccc;font-weight:bold">現在の在庫アラート</td>
    <td style="padding:10px 16px;border:1px solid #ccc;color:${alertCount > 0 ? '#DC2626' : '#1B3A2D'}">
      <strong>${alertCount} 品目</strong>${alertCount > 0 ? '（要発注）' : '（問題なし）'}
    </td>
  </tr>
</table>
<p style="color:#888;font-size:0.85em">このメールは ${process.env.COMPANY_NAME || '材木店'} 在庫管理システムが自動送信しました。</p>
</body></html>`;

  const result = await sendMail({ to: fromAddress, subject, html });
  if (result) console.log('[Gmail] 月次レポート送信完了:', monthLabel);
  return result;
}

// ────────────────────────────────────────────────────────────────
// ヘルパー: バックグラウンド実行
// ────────────────────────────────────────────────────────────────

function runAsync(fn, ...args) {
  setImmediate(async () => {
    try { await fn(...args); }
    catch (err) { console.error(`[Gmail] 非同期エラー (${fn.name}):`, err.message); }
  });
}

module.exports = {
  initGmail,
  sendInvoiceEmail,
  sendOrderConfirmEmail,
  sendStockAlertEmail,
  sendMonthlyReportEmail,
  runAsync,
};
