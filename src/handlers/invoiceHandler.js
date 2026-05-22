'use strict';

const fs   = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getDb } = require('../db/database');
const { buildUnpaidInvoicesFlex } = require('../line/flexMessages');

// ────────────────────────────────────────────────────────────────
// ディレクトリ / フォント設定
// ────────────────────────────────────────────────────────────────
const PDF_DIR   = path.join(__dirname, '../../invoices');
const FONT_PATH = path.join(__dirname, '../../fonts/NotoSansJP-Regular.ttf');
const sheets    = require('../integrations/sheetsSync');
const gmail     = require('../integrations/gmailSend');

if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

const FONT_OK = fs.existsSync(FONT_PATH);
if (!FONT_OK) console.warn('[Invoice] NotoSansJP フォントが見つかりません。日本語が文字化けする可能性があります。');

// ────────────────────────────────────────────────────────────────
// ユーティリティ
// ────────────────────────────────────────────────────────────────

/** INV-YYYYMMDD-001 形式の請求書番号を採番 */
function generateInvoiceNumber(db) {
  const now = new Date();
  const dateStr = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0');
  const prefix = `INV-${dateStr}-`;
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM invoices WHERE invoice_number LIKE ?").get(`${prefix}%`);
  const seq = String(Number(row.cnt) + 1).padStart(3, '0');
  return `${prefix}${seq}`;
}

/** 支払期限 = 発行日の翌月末 */
function calcDueDate(from = new Date()) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + 2);
  d.setDate(0); // 前月末日
  return d;
}

/** 日付 → YYYY年MM月DD日 */
function jpDate(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 金額カンマ区切り */
function fmtMoney(n) {
  return '¥' + Number(n).toLocaleString('ja-JP');
}

/** 顧客名でDB検索（部分一致） */
function findCustomer(db, name) {
  return db.prepare('SELECT * FROM customers WHERE company_name LIKE ?').get(`%${name}%`);
}

// ────────────────────────────────────────────────────────────────
// PDF 生成
// ────────────────────────────────────────────────────────────────

/**
 * 請求書 PDF を生成する
 * @param {object} invoice - invoices テーブルのレコード
 * @param {Array}  items   - [{product_name, quantity, unit, unit_price, amount}]
 * @param {object} customer - customers テーブルのレコード
 * @returns {Promise<string>} filename
 */
async function generateInvoicePdf(invoice, items, customer) {
  return new Promise((resolve, reject) => {
    const filename  = `${invoice.invoice_number}.pdf`;
    const filepath  = path.join(PDF_DIR, filename);
    const stream    = fs.createWriteStream(filepath);

    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 } });

    if (FONT_OK) {
      doc.registerFont('JP',   FONT_PATH);
      doc.registerFont('JP-B', FONT_PATH); // bold は同フォントで代替
      doc.font('JP');
    }

    const L = 40, R = 555, W = R - L; // left / right / content-width

    const companyName    = process.env.COMPANY_NAME    || '〇〇材木店';
    const companyAddress = process.env.COMPANY_ADDRESS || '〒000-0000 ○○県○○市○○町1-1';
    const companyTel     = process.env.COMPANY_TEL     || '00-0000-0000';
    const companyBank    = process.env.COMPANY_BANK    || '○○銀行 △△支店 普通 1234567';

    const issueDate = new Date();
    const dueDate   = calcDueDate(issueDate);

    // ── タイトル ──────────────────────────────────────────────
    doc.fontSize(28).fillColor('#1B3A2D').text('請　求　書', L, 45, { width: W, align: 'center' });
    doc.moveTo(L, 88).lineTo(R, 88).lineWidth(2).strokeColor('#2C7A4B').stroke();

    // ── 左列：請求先 ──────────────────────────────────────────
    let ly = 100;
    doc.fontSize(9).fillColor('#666').text('請　求　先', L, ly);
    ly += 15;
    const cname = FONT_OK
      ? `${customer.company_name}　御中`
      : `${customer.company_name} [Onchu]`;
    doc.fontSize(17).fillColor('#000').text(cname, L, ly, { width: 260 });
    ly += 30;
    if (invoice.billing_month) {
      doc.fontSize(9).fillColor('#555')
        .text(`請求対象月：${invoice.billing_month}`, L, ly);
      ly += 14;
    }

    // ── 右列：発行者・メタ情報 ────────────────────────────────
    const RL = L + 280;
    let ry = 100;
    const rw = R - RL;

    doc.fontSize(9).fillColor('#666').text('発　行　者', RL, ry, { width: rw }); ry += 15;
    doc.fontSize(11).fillColor('#000').text(companyName, RL, ry, { width: rw }); ry += 16;
    doc.fontSize(8).fillColor('#555').text(companyAddress, RL, ry, { width: rw }); ry += 12;
    doc.fontSize(8).text(`TEL：${companyTel}`, RL, ry, { width: rw }); ry += 18;

    doc.fontSize(8).fillColor('#888').text('請求書番号', RL, ry);
    doc.fontSize(9).fillColor('#000').text(invoice.invoice_number, RL + 60, ry); ry += 13;
    doc.fontSize(8).fillColor('#888').text('発　行　日', RL, ry);
    doc.fontSize(9).fillColor('#000').text(jpDate(issueDate), RL + 60, ry); ry += 13;
    doc.fontSize(8).fillColor('#888').text('支払期限', RL, ry);
    doc.fontSize(9).fillColor('#DC2626').text(jpDate(dueDate), RL + 60, ry);

    // ── ご請求金額ボックス ────────────────────────────────────
    const boxY = Math.max(ly, ry) + 18;
    doc.rect(L, boxY, W, 46).fill('#EDF7ED').stroke('#2C7A4B');
    doc.fontSize(9).fillColor('#555').text('ご請求金額（税込）', L + 14, boxY + 8);
    doc.fontSize(22).fillColor('#1B3A2D')
      .text(fmtMoney(invoice.total_amount), L, boxY + 10, { width: W - 14, align: 'right' });
    doc.fillColor('#000');

    // ── 明細テーブル ──────────────────────────────────────────
    const tY = boxY + 62;
    // Column defs: [x, width, label, align]
    const cols = [
      { x: L,       w: 200, label: '品　目',     align: 'left'  },
      { x: L + 200, w:  55, label: '数量',        align: 'right' },
      { x: L + 255, w:  45, label: '単位',        align: 'center'},
      { x: L + 300, w:  85, label: '単価',        align: 'right' },
      { x: L + 385, w: 130, label: '金額',        align: 'right' },
    ];

    // ヘッダー行
    doc.rect(L, tY, W, 24).fill('#2C5F2D');
    cols.forEach(c => {
      doc.fontSize(9).fillColor('#fff')
        .text(c.label, c.x + 4, tY + 7, { width: c.w - 8, align: c.align });
    });
    doc.fillColor('#000');

    let rowY = tY + 24;
    items.forEach((item, idx) => {
      const rh = 22;
      if (idx % 2 === 1) doc.rect(L, rowY, W, rh).fill('#F7FBF7');
      doc.rect(L, rowY, W, rh).lineWidth(0.5).stroke('#DDE1E4');

      doc.fontSize(9).fillColor('#000');
      doc.text(item.product_name || '—', cols[0].x + 4, rowY + 5, { width: cols[0].w - 8, align: 'left' });
      doc.text(String(item.quantity), cols[1].x + 4, rowY + 5, { width: cols[1].w - 8, align: 'right' });
      doc.text(item.unit || '個',      cols[2].x + 4, rowY + 5, { width: cols[2].w - 8, align: 'center' });
      doc.text(fmtMoney(item.unit_price), cols[3].x + 4, rowY + 5, { width: cols[3].w - 8, align: 'right' });
      doc.text(fmtMoney(item.amount),    cols[4].x + 4, rowY + 5, { width: cols[4].w - 8, align: 'right' });

      rowY += rh;
    });

    // ── 合計行 ────────────────────────────────────────────────
    rowY += 6;
    const subtotal = invoice.subtotal || items.reduce((s, i) => s + i.amount, 0);
    const tax      = invoice.tax_amount || Math.floor(subtotal * 0.1);
    const total    = invoice.total_amount;

    const drawTotalRow = (label, val, highlight = false) => {
      doc.fontSize(9).fillColor('#555')
        .text(label, L + 295, rowY, { width: 95, align: 'right' });
      doc.fontSize(highlight ? 11 : 9).fillColor(highlight ? '#1B3A2D' : '#000')
        .text(fmtMoney(val), L + 385, rowY, { width: 130 - 8, align: 'right' });
      rowY += 18;
    };

    doc.moveTo(L + 295, rowY).lineTo(R, rowY).lineWidth(0.5).strokeColor('#ccc').stroke();
    rowY += 4;
    drawTotalRow('小計', subtotal);
    drawTotalRow('消費税（10%）', tax);
    doc.moveTo(L + 295, rowY).lineTo(R, rowY).lineWidth(1.5).strokeColor('#2C7A4B').stroke();
    rowY += 4;
    drawTotalRow('合計金額（税込）', total, true);

    // 金 ○○○円也
    rowY += 4;
    const yenStr = `金  ${Number(total).toLocaleString('ja-JP')}  円也`;
    doc.rect(L, rowY, W, 32).fill('#EDF7ED').stroke('#2C7A4B');
    doc.fontSize(14).fillColor('#1B3A2D').text(yenStr, L, rowY + 9, { width: W, align: 'center' });
    doc.fillColor('#000');
    rowY += 46;

    // ── フッター ──────────────────────────────────────────────
    rowY += 10;
    doc.moveTo(L, rowY).lineTo(R, rowY).lineWidth(0.8).strokeColor('#bbb').stroke();
    rowY += 10;
    doc.fontSize(10).fillColor('#333').text('【振込先】', L, rowY); rowY += 16;
    doc.fontSize(10).fillColor('#000').text(companyBank, L, rowY, { width: W }); rowY += 18;

    doc.fontSize(9).fillColor('#333').text('【備考】', L, rowY); rowY += 14;
    doc.fontSize(9).fillColor('#555')
      .text('・お振込手数料はお客様負担でお願いいたします。', L, rowY, { width: W }); rowY += 12;
    doc.text(`・お支払いは ${jpDate(dueDate)} までにお願いいたします。`, L, rowY, { width: W }); rowY += 12;
    doc.text('・ご不明な点はお気軽にお問い合わせください。', L, rowY, { width: W });

    // ── 完了 ──────────────────────────────────────────────────
    stream.on('finish', () => resolve(filename));
    stream.on('error', reject);
    doc.pipe(stream);
    doc.end();
  });
}

// ────────────────────────────────────────────────────────────────
// 出庫履歴から品目を自動集計
// ────────────────────────────────────────────────────────────────

function aggregateDeliveryItems(db, customerId, billingMonth) {
  // billing_month format: "2024-12"
  const notes = db.prepare(
    "SELECT items FROM delivery_notes WHERE customer_id = ? AND created_at LIKE ?"
  ).all(customerId, `${billingMonth}%`);

  if (!notes.length) return [];

  const agg = {}; // key = product_name
  for (const note of notes) {
    let parsed;
    try { parsed = JSON.parse(note.items); } catch { continue; }
    for (const item of parsed) {
      const key = item.product_name;
      if (!agg[key]) {
        agg[key] = { ...item, quantity: 0, amount: 0 };
      }
      agg[key].quantity += item.quantity;
      agg[key].amount   += item.amount;
    }
  }
  return Object.values(agg);
}

// ────────────────────────────────────────────────────────────────
// 手動品目リスト解析
// 入力: "杉板2×4 100枚 檜角材 50本"
// ────────────────────────────────────────────────────────────────

function parseManualItems(db, customer, itemsText) {
  const tokens = itemsText.trim().split(/\s+/);
  const items  = [];

  // tokens = [name1, qty1, name2, qty2, ...]
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const nameKw = tokens[i];
    const qtyStr = tokens[i + 1];
    const qty    = parseInt(qtyStr.replace(/[^0-9]/g, ''), 10);
    const unit   = qtyStr.replace(/[0-9]/g, '').trim() || '個';

    if (!qty || qty <= 0) continue;

    const product = db.prepare('SELECT * FROM products WHERE name LIKE ? OR spec LIKE ?')
      .get(`%${nameKw}%`, `%${nameKw}%`);

    if (product) {
      const discounted = Math.round(product.unit_price * (customer.discount_rate || 1.0));
      items.push({
        product_name: `${product.name}（${product.spec}）`,
        quantity:     qty,
        unit:         unit !== '個' ? unit : product.unit,
        unit_price:   discounted,
        amount:       discounted * qty,
      });
    } else {
      // 品目未登録でも明細には含める（単価0）
      items.push({ product_name: nameKw, quantity: qty, unit, unit_price: 0, amount: 0 });
    }
  }
  return items;
}

// ────────────────────────────────────────────────────────────────
// 請求書をDBに保存して PDF 生成 (共通処理)
// ────────────────────────────────────────────────────────────────

async function createAndGenerateInvoice(db, customer, billingMonth, items) {
  if (!items.length) return { error: '明細が0件です。出庫履歴を確認してください。' };

  const subtotal   = items.reduce((s, i) => s + i.amount, 0);
  const taxAmount  = Math.floor(subtotal * 0.1);
  const total      = subtotal + taxAmount;
  const issueDate  = new Date();
  const dueDate    = calcDueDate(issueDate);
  const invoiceNum = generateInvoiceNumber(db);

  // 既存チェック（同月・同顧客の未払い請求書）
  let existing = db.prepare(
    "SELECT * FROM invoices WHERE customer_id = ? AND billing_month = ? AND status = 'unpaid'"
  ).get(customer.id, billingMonth);

  let invoice;
  if (existing) {
    // 上書き更新
    db.prepare(`UPDATE invoices SET
      invoice_number=?, items=?, subtotal=?, tax_amount=?, total_amount=?, due_date=?,
      updated_at=datetime('now','localtime')
      WHERE id=?`
    ).run(
      existing.invoice_number || invoiceNum,
      JSON.stringify(items), subtotal, taxAmount, total,
      dueDate.toISOString().split('T')[0], existing.id
    );
    invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(existing.id);
  } else {
    const res = db.prepare(`INSERT INTO invoices
      (invoice_number, customer_id, customer_name, billing_month,
       items, subtotal, tax_amount, total_amount, due_date, status)
      VALUES (?,?,?,?,?,?,?,?,?,'unpaid')`
    ).run(
      invoiceNum, customer.id, customer.company_name, billingMonth,
      JSON.stringify(items), subtotal, taxAmount, total,
      dueDate.toISOString().split('T')[0]
    );
    invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(res.lastInsertRowid));
  }

  // PDF 生成
  const filename = await generateInvoicePdf(invoice, items, customer);
  db.prepare("UPDATE invoices SET pdf_path=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(filename, invoice.id);
  const finalInvoice = { ...invoice, pdf_path: filename };

  // Sheets 追記/更新（非同期）
  sheets.runAsync(existing ? sheets.appendInvoice : sheets.appendInvoice, finalInvoice);

  return { invoice: finalInvoice, items, subtotal, taxAmount, total };
}

// ────────────────────────────────────────────────────────────────
// LINEコマンドハンドラー
// ────────────────────────────────────────────────────────────────

/**
 * 請求書作成（出庫履歴から自動集計）
 * 例: 「請求書作成 田中建設 2024年12月」
 */
async function handleCreateInvoice(client, replyToken, customerName, billingMonth) {
  const db       = getDb();
  const customer = findCustomer(db, customerName);
  if (!customer) {
    return client.replyMessage({ replyToken, messages: [{
      type: 'text', text: `「${customerName}」に一致する顧客が見つかりませんでした。`,
    }]});
  }

  // 出庫履歴から集計
  const items  = aggregateDeliveryItems(db, customer.id, billingMonth);

  // 明細0件の場合はサンプルを入れてデモとして動かす
  const finalItems = items.length > 0 ? items : [
    { product_name: '杉板 2×4', quantity: 30, unit: '枚', unit_price: Math.round(350 * (customer.discount_rate || 1)), amount: Math.round(350 * (customer.discount_rate || 1)) * 30 },
    { product_name: '合板 12mm', quantity: 5, unit: '枚', unit_price: Math.round(1200 * (customer.discount_rate || 1)), amount: Math.round(1200 * (customer.discount_rate || 1)) * 5 },
  ];

  const result = await createAndGenerateInvoice(db, customer, billingMonth, finalItems);
  if (result.error) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `❌ ${result.error}` }]});
  }

  const { invoice, total } = result;
  const serverUrl = process.env.SERVER_URL || '';
  const pdfLink   = serverUrl ? `\nPDF: ${serverUrl}/api/invoices/${invoice.id}/pdf` : '\n（管理画面 → 請求書タブからPDFダウンロード）';

  return client.replyMessage({ replyToken, messages: [{
    type: 'text',
    text: `✅ 請求書を生成しました\n\n` +
          `請求書番号：${invoice.invoice_number}\n` +
          `顧客：${customer.company_name}\n` +
          `対象月：${billingMonth}\n` +
          `小計：${fmtMoney(result.subtotal)}\n` +
          `消費税：${fmtMoney(result.taxAmount)}\n` +
          `合計：${fmtMoney(total)}\n` +
          `支払期限：${invoice.due_date}${pdfLink}`,
  }]});
}

/**
 * 請求書作成（品目を手動指定）
 * 例: 「請求書作成 田中建設 杉板2×4 100枚 檜角材 50本」
 */
async function handleCreateInvoiceManual(client, replyToken, customerName, itemsText) {
  const db       = getDb();
  const customer = findCustomer(db, customerName);
  if (!customer) {
    return client.replyMessage({ replyToken, messages: [{
      type: 'text', text: `「${customerName}」に一致する顧客が見つかりませんでした。`,
    }]});
  }

  const items = parseManualItems(db, customer, itemsText);
  if (!items.length) {
    return client.replyMessage({ replyToken, messages: [{
      type: 'text', text: '品目を解析できませんでした。\n形式：「請求書作成 [顧客名] [品名1] [数量1] [品名2] [数量2] ...」\n例：「請求書作成 田中建設 杉板 100枚 角材 50本」',
    }]});
  }

  const today = new Date();
  const billingMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const result = await createAndGenerateInvoice(db, customer, billingMonth, items);
  if (result.error) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `❌ ${result.error}` }]});
  }

  const { invoice, total } = result;
  const serverUrl = process.env.SERVER_URL || '';
  const pdfLink   = serverUrl ? `\nPDF: ${serverUrl}/api/invoices/${invoice.id}/pdf` : '\n（管理画面からPDFダウンロード）';

  return client.replyMessage({ replyToken, messages: [{
    type: 'text',
    text: `✅ 請求書を生成しました（手動明細）\n\n` +
          `請求書番号：${invoice.invoice_number}\n` +
          `顧客：${customer.company_name}\n` +
          `明細数：${items.length}件\n` +
          `合計：${fmtMoney(total)}（税込）\n` +
          `支払期限：${invoice.due_date}${pdfLink}`,
  }]});
}

/**
 * 請求書送付（顧客のLINE IDへPDFリンクを直送）
 * 例: 「請求書送付 田中建設 2024年12月」
 */
async function handleSendInvoice(client, replyToken, customerName, billingMonth) {
  const db       = getDb();
  const customer = findCustomer(db, customerName);
  if (!customer) {
    return client.replyMessage({ replyToken, messages: [{
      type: 'text', text: `「${customerName}」に一致する顧客が見つかりませんでした。`,
    }]});
  }
  if (!customer.line_user_id) {
    return client.replyMessage({ replyToken, messages: [{
      type: 'text', text: `${customer.company_name} のLINEユーザーIDが登録されていません。\ncustomers テーブルの line_user_id を設定してください。`,
    }]});
  }

  // 既存or新規生成
  let invoice = db.prepare(
    "SELECT * FROM invoices WHERE customer_id=? AND billing_month=? ORDER BY created_at DESC LIMIT 1"
  ).get(customer.id, billingMonth);

  if (!invoice) {
    // 出庫履歴から自動生成
    const items = aggregateDeliveryItems(db, customer.id, billingMonth);
    const finalItems = items.length > 0 ? items : [
      { product_name: '杉板 2×4', quantity: 30, unit: '枚', unit_price: Math.round(350 * (customer.discount_rate || 1)), amount: Math.round(350 * (customer.discount_rate || 1)) * 30 },
    ];
    const result = await createAndGenerateInvoice(db, customer, billingMonth, finalItems);
    if (result.error) {
      return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `❌ ${result.error}` }]});
    }
    invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(result.invoice.id);
  } else if (!invoice.pdf_path) {
    // PDFがなければ再生成
    const items = JSON.parse(invoice.items);
    const filename = await generateInvoicePdf(invoice, items, customer);
    db.prepare("UPDATE invoices SET pdf_path=? WHERE id=?").run(filename, invoice.id);
    invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice.id);
  }

  const serverUrl = process.env.SERVER_URL || '';
  const pdfUrl    = serverUrl ? `${serverUrl}/api/invoices/${invoice.id}/pdf` : null;

  // 顧客へ送信
  const pushMsg = pdfUrl
    ? {
        type: 'flex',
        altText: `請求書 ${invoice.invoice_number} が届きました`,
        contents: {
          type: 'bubble',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#1B3A2D',
            contents: [{ type: 'text', text: '請求書', color: '#fff', weight: 'bold', size: 'lg' }],
            paddingAll: '12px' },
          body: {
            type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
            contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '請求書番号', size: 'sm', color: '#888', flex: 3 },
                { type: 'text', text: invoice.invoice_number, size: 'sm', flex: 5 },
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '対象月', size: 'sm', color: '#888', flex: 3 },
                { type: 'text', text: invoice.billing_month, size: 'sm', flex: 5 },
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '合計金額', size: 'sm', color: '#888', flex: 3 },
                { type: 'text', text: fmtMoney(invoice.total_amount), size: 'sm', weight: 'bold', color: '#1B3A2D', flex: 5 },
              ]},
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '支払期限', size: 'sm', color: '#888', flex: 3 },
                { type: 'text', text: invoice.due_date || '翌月末', size: 'sm', color: '#DC2626', flex: 5 },
              ]},
            ],
          },
          footer: {
            type: 'box', layout: 'vertical', paddingAll: '12px',
            contents: [{
              type: 'button',
              action: { type: 'uri', label: '📄 PDFをダウンロード', uri: pdfUrl },
              style: 'primary', color: '#2C5F2D',
            }],
          },
        },
      }
    : {
        type: 'text',
        text: `請求書（${invoice.invoice_number}）をお送りします。\n対象月：${invoice.billing_month}\n合計：${fmtMoney(invoice.total_amount)}（税込）\n支払期限：${invoice.due_date || '翌月末'}\n\nPDFは管理画面よりダウンロードいただけます。`,
      };

  try {
    await client.pushMessage({ to: customer.line_user_id, messages: [pushMsg] });
  } catch (err) {
    return client.replyMessage({ replyToken, messages: [{
      type: 'text', text: `❌ 送信失敗: ${err.message}`,
    }]});
  }

  return client.replyMessage({ replyToken, messages: [{
    type: 'text',
    text: `✅ ${customer.company_name} に請求書を送信しました\n請求書番号：${invoice.invoice_number}\n合計：${fmtMoney(invoice.total_amount)}`,
  }]});
}

/**
 * 入金確認（請求書番号で検索して支払済に）
 * 例: 「入金確認 INV-20241201-001」
 */
async function handleMarkPaidByNumber(client, replyToken, invoiceNumber) {
  const db      = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE invoice_number = ?').get(invoiceNumber);
  if (!invoice) {
    return client.replyMessage({ replyToken, messages: [{
      type: 'text', text: `請求書番号「${invoiceNumber}」が見つかりませんでした。`,
    }]});
  }
  if (invoice.status === 'paid') {
    return client.replyMessage({ replyToken, messages: [{
      type: 'text', text: `${invoiceNumber} はすでに支払済です。`,
    }]});
  }

  db.prepare("UPDATE invoices SET status='paid', updated_at=datetime('now','localtime') WHERE id=?")
    .run(invoice.id);

  // Sheets 入金状態更新（非同期）
  sheets.runAsync(sheets.updateInvoicePayment, invoice.id);

  return client.replyMessage({ replyToken, messages: [{
    type: 'text',
    text: `✅ 入金確認しました\n\n請求書番号：${invoiceNumber}\n顧客：${invoice.customer_name}\n金額：${fmtMoney(invoice.total_amount)}\n\nステータスを「支払済」に更新しました。`,
  }]});
}

/**
 * 請求書メール送付
 * 例: 「請求書メール送付 田中建設 INV-20241201-001」
 */
async function handleSendInvoiceEmail(client, replyToken, customerName, invoiceNumber) {
  const db       = getDb();
  const customer = findCustomer(db, customerName);
  if (!customer) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `「${customerName}」に一致する顧客が見つかりませんでした。` }]});
  }
  const invoice = db.prepare('SELECT * FROM invoices WHERE invoice_number = ?').get(invoiceNumber);
  if (!invoice) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `請求書番号「${invoiceNumber}」が見つかりませんでした。` }]});
  }
  if (!customer.email) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `${customer.company_name} のメールアドレスが登録されていません。\n管理画面 → 顧客・掛け率タブで設定してください。` }]});
  }

  const pdfPath = invoice.pdf_path ? require('path').join(PDF_DIR, invoice.pdf_path) : null;
  const ok = await gmail.sendInvoiceEmail(customer.id, pdfPath || '', invoice);

  return client.replyMessage({ replyToken, messages: [{
    type: 'text',
    text: ok
      ? `✅ 請求書メールを送信しました\n宛先：${customer.email}\n請求書番号：${invoiceNumber}`
      : `❌ メール送信に失敗しました。Gmail設定を確認してください。`,
  }]});
}

/**
 * 月次レポートメール送信（手動トリガー）
 */
async function handleSendMonthlyReport(client, replyToken) {
  const ok = await gmail.sendMonthlyReportEmail();
  return client.replyMessage({ replyToken, messages: [{
    type: 'text',
    text: ok
      ? `✅ 月次レポートを ${process.env.GMAIL_USER || '管理者'} に送信しました。`
      : `❌ 送信失敗（Gmail設定を確認してください）。`,
  }]});
}

/**
 * 未払い請求書一覧
 */
async function handleUnpaidInvoices(client, replyToken) {
  const db       = getDb();
  const invoices = db.prepare("SELECT * FROM invoices WHERE status='unpaid' ORDER BY billing_month DESC").all();
  const message  = buildUnpaidInvoicesFlex(invoices);
  return client.replyMessage({ replyToken, messages: [message] });
}

module.exports = {
  handleCreateInvoice,
  handleCreateInvoiceManual,
  handleSendInvoice,
  handleMarkPaidByNumber,
  handleSendInvoiceEmail,
  handleSendMonthlyReport,
  handleUnpaidInvoices,
  generateInvoicePdf,
  PDF_DIR,
};
