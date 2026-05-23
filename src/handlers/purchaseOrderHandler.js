'use strict';

const fs   = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getDb } = require('../db/database');

// ────────────────────────────────────────────────────────────────
// ディレクトリ / フォント設定
// ────────────────────────────────────────────────────────────────
const PO_DIR    = path.join(__dirname, '../../purchase_orders');
const FONT_PATH = path.join(__dirname, '../../fonts/NotoSansJP-Regular.ttf');

if (!fs.existsSync(PO_DIR)) fs.mkdirSync(PO_DIR, { recursive: true });

const FONT_OK = fs.existsSync(FONT_PATH);
if (!FONT_OK) console.warn('[PurchaseOrder] NotoSansJP フォントが見つかりません。');

// ────────────────────────────────────────────────────────────────
// ユーティリティ
// ────────────────────────────────────────────────────────────────

/** PO-YYYYMMDD-001 形式の発注書番号を採番 */
function generatePoNumber(db) {
  const now = new Date();
  const dateStr = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0');
  const prefix = `PO-${dateStr}-`;
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM orders WHERE purchase_order_path LIKE ?"
  ).get(`%${prefix}%`);
  const seq = String(Number(row.cnt) + 1).padStart(3, '0');
  return `${prefix}${seq}`;
}

/** 日付 → YYYY年MM月DD日 */
function jpDate(d = new Date()) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 日付 → YYYY/MM/DD */
function slashDate(d = new Date()) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** 納品希望日（発注日 +7日） */
function deliveryDate(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 7);
  return d;
}

/** 金額カンマ区切り */
function fmtMoney(n) {
  return '¥' + Number(n).toLocaleString('ja-JP');
}

// ────────────────────────────────────────────────────────────────
// PDF 生成
// ────────────────────────────────────────────────────────────────

/**
 * 発注書PDFを生成する
 * @param {object} order    - ordersテーブルのレコード
 * @param {object} supplier - suppliersテーブルのレコード
 * @returns {{ pdfPath: string, poNumber: string, deliveryDateObj: Date }}
 */
async function generatePurchaseOrderPdf(order, supplier) {
  const db       = getDb();
  const poNumber = generatePoNumber(db);
  const now      = new Date();
  const delDate  = deliveryDate(now);

  const unitPrice   = order.unit_price || 0;
  const quantity    = order.quantity   || 0;
  const subtotal    = unitPrice * quantity;
  const tax         = Math.floor(subtotal * 0.1);
  const total       = subtotal + tax;

  const fileName = `${poNumber}.pdf`;
  const pdfPath  = path.join(PO_DIR, fileName);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // フォント設定
    if (FONT_OK) {
      doc.registerFont('NotoSansJP', FONT_PATH);
      doc.font('NotoSansJP');
    }

    const pageW = doc.page.width;   // 595
    const marginL = 50;
    const marginR = 50;
    const contentW = pageW - marginL - marginR; // 495

    // ── タイトル ──────────────────────────────────────────────
    doc.fontSize(26).text('発 注 書', { align: 'center' });
    doc.moveDown(0.5);

    // ── 右上: 発注書番号・日付 ────────────────────────────────
    const rightX = pageW - marginR - 200;
    const infoY  = doc.y;
    doc.fontSize(9).fillColor('#444');
    doc.text(`発注書番号： ${poNumber}`, rightX, infoY, { width: 200, align: 'left' });
    doc.text(`発注日：　　 ${slashDate(now)}`,        rightX, doc.y, { width: 200, align: 'left' });
    doc.text(`納品希望日： ${slashDate(delDate)}`,    rightX, doc.y, { width: 200, align: 'left' });

    // ── 発注元（左）/ 発注先（右）ブロック ─────────────────────
    const blockY  = Math.max(infoY + 60, 160);
    const companyName    = process.env.COMPANY_NAME    || '株式会社〇〇材木店';
    const companyAddress = process.env.COMPANY_ADDRESS || '';
    const companyTel     = process.env.COMPANY_TEL     || '';

    // 発注元ラベル
    doc.fontSize(8).fillColor('#888')
       .text('【発注元】', marginL, blockY);
    doc.fontSize(11).fillColor('#000')
       .text(companyName, marginL, doc.y);
    doc.fontSize(9).fillColor('#444');
    if (companyAddress) doc.text(companyAddress, marginL, doc.y);
    if (companyTel)     doc.text(`TEL: ${companyTel}`, marginL, doc.y);

    // 発注先ラベル（右半分）
    const rightColX = marginL + contentW / 2;
    doc.fontSize(8).fillColor('#888')
       .text('【発注先】', rightColX, blockY);
    doc.fontSize(11).fillColor('#000')
       .text(supplier.company_name || '—', rightColX, blockY + 12);
    doc.fontSize(9).fillColor('#444');
    if (supplier.contact_person)
      doc.text(`担当者: ${supplier.contact_person}`, rightColX, doc.y);
    if (supplier.email)
      doc.text(`Email: ${supplier.email}`, rightColX, doc.y);
    if (supplier.tel || supplier.phone)
      doc.text(`TEL: ${supplier.tel || supplier.phone}`, rightColX, doc.y);

    // ── 水平線 ────────────────────────────────────────────────
    const lineY = blockY + 80;
    doc.moveTo(marginL, lineY).lineTo(pageW - marginR, lineY).strokeColor('#aaa').lineWidth(0.5).stroke();

    // ── 明細テーブル ──────────────────────────────────────────
    const tableTop = lineY + 12;
    const colW = [30, 200, 60, 50, 80, 80]; // No, 品目名, 数量, 単位, 単価, 金額
    const colLabels = ['No', '品目名', '数量', '単位', '単価', '金額'];
    let curX = marginL;

    // ヘッダー背景
    doc.rect(marginL, tableTop, contentW, 18).fillColor('#2C7A4B').fill();
    doc.fillColor('#fff').fontSize(9);
    colLabels.forEach((lbl, i) => {
      doc.text(lbl, curX + 2, tableTop + 4, { width: colW[i] - 4, align: i >= 4 ? 'right' : 'center' });
      curX += colW[i];
    });

    // データ行
    const rowH = 18;
    const rowY = tableTop + 18;
    const unit = order.unit || '';

    doc.fillColor('#000').fontSize(9);
    curX = marginL;
    doc.rect(marginL, rowY, contentW, rowH).fillColor('#f9f9f9').fill();
    doc.fillColor('#000');

    const rowData = [
      { text: '1',                        align: 'center' },
      { text: order.product_name || '—',  align: 'left' },
      { text: String(quantity),           align: 'right' },
      { text: unit,                       align: 'center' },
      { text: fmtMoney(unitPrice),        align: 'right' },
      { text: fmtMoney(subtotal),         align: 'right' },
    ];
    rowData.forEach((cell, i) => {
      doc.text(cell.text, curX + 2, rowY + 4, { width: colW[i] - 4, align: cell.align });
      curX += colW[i];
    });

    // テーブル枠線
    const tableBottom = rowY + rowH;
    doc.strokeColor('#bbb').lineWidth(0.5);
    // 外枠
    doc.rect(marginL, tableTop, contentW, tableBottom - tableTop).stroke();
    // 縦線
    let cx = marginL;
    colW.slice(0, -1).forEach(w => {
      cx += w;
      doc.moveTo(cx, tableTop).lineTo(cx, tableBottom).stroke();
    });
    // 横線（ヘッダー下）
    doc.moveTo(marginL, rowY).lineTo(pageW - marginR, rowY).stroke();

    // ── 合計ブロック ──────────────────────────────────────────
    const sumX    = pageW - marginR - 180;
    const sumTopY = tableBottom + 16;

    doc.fillColor('#000').fontSize(9);
    const sumRows = [
      ['小　計', fmtMoney(subtotal)],
      ['消費税 (10%)', fmtMoney(tax)],
    ];
    let sy = sumTopY;
    sumRows.forEach(([label, val]) => {
      doc.text(label, sumX, sy, { width: 90, align: 'left' });
      doc.text(val,   sumX + 90, sy, { width: 90, align: 'right' });
      sy += 16;
    });
    // 合計行（強調）
    doc.rect(sumX - 4, sy, 184, 20).fillColor('#EDF7ED').fill();
    doc.fillColor('#000').fontSize(10).font(FONT_OK ? 'NotoSansJP' : 'Helvetica');
    doc.text('合　計', sumX, sy + 4, { width: 90, align: 'left' });
    doc.text(fmtMoney(total), sumX + 90, sy + 4, { width: 90, align: 'right' });
    doc.rect(sumX - 4, sy, 184, 20).strokeColor('#2C7A4B').lineWidth(1).stroke();

    // ── 備考欄 ────────────────────────────────────────────────
    const remarkY = sy + 36;
    doc.fontSize(8).fillColor('#888').text('【備考】', marginL, remarkY);
    doc.fontSize(9).fillColor('#333')
       .text('上記の通り発注いたします。納品の際は事前にご連絡ください。',
             marginL, remarkY + 12, { width: contentW });

    // ── 発注者・印鑑欄 ────────────────────────────────────────
    const stampY = remarkY + 50;
    doc.fontSize(9).fillColor('#444')
       .text('発注者：' + companyName, marginL, stampY);

    // 印鑑の空白四角（40×40px）
    const stampBoxX = pageW - marginR - 60;
    doc.rect(stampBoxX, stampY - 4, 40, 40).strokeColor('#555').lineWidth(0.8).stroke();
    doc.fontSize(7).fillColor('#aaa').text('印', stampBoxX + 14, stampY + 13);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error',  reject);
  });

  return { pdfPath, poNumber, deliveryDateObj: delDate };
}

module.exports = { generatePurchaseOrderPdf, PO_DIR };
