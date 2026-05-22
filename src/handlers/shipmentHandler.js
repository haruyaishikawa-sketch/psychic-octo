'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getDb } = require('../db/database');

const SHIPMENT_DIR = path.join(__dirname, '../../shipments');
const FONT_PATH = path.join(__dirname, '../../fonts/NotoSansJP-Regular.ttf');
const FONT_OK = fs.existsSync(FONT_PATH);
if (!fs.existsSync(SHIPMENT_DIR)) fs.mkdirSync(SHIPMENT_DIR, { recursive:true });

function generateSlipNumber(db) {
  const now = new Date();
  const dateStr = now.getFullYear().toString()
    + String(now.getMonth()+1).padStart(2,'0')
    + String(now.getDate()).padStart(2,'0');
  const prefix = `SHP-${dateStr}-`;
  // received_ordersテーブルかdeliveriesから採番（シンプルにタイムスタンプ使用）
  const seq = db.prepare("SELECT COUNT(*) as c FROM deliveries WHERE delivery_date = date('now','localtime')").get().c + 1;
  return prefix + String(seq).padStart(3,'0');
}

async function generateShipmentPdf(order, customer) {
  return new Promise((resolve, reject) => {
    const slipNumber = `SHP-${Date.now()}`;
    const filename = `shipment-${order.order_number}-${Date.now()}.pdf`;
    const filePath = path.join(SHIPMENT_DIR, filename);

    const doc = new PDFDocument({ size:'A4', margin:40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const font = n => FONT_OK ? doc.font(FONT_PATH).fontSize(n) : doc.fontSize(n);
    const today = new Date().toLocaleDateString('ja-JP', { year:'numeric', month:'long', day:'numeric' });
    const items = JSON.parse(order.items || '[]');

    // タイトル
    font(24).text('出 荷 伝 票', { align:'center' });
    doc.moveDown(0.5);

    // 伝票番号・出荷日
    font(10);
    doc.text(`伝票番号: ${slipNumber}`, { align:'right' });
    doc.text(`出荷日: ${today}`, { align:'right' });
    doc.moveDown(0.5);

    // 出荷先
    doc.moveTo(40,doc.y).lineTo(555,doc.y).stroke();
    doc.moveDown(0.3);
    font(11).text('【出荷先】');
    font(13).text(`${order.customer_name} 御中`);
    if (customer && customer.address) font(10).text(customer.address || '');
    doc.moveDown(0.5);

    // 品目テーブル
    doc.moveTo(40,doc.y).lineTo(555,doc.y).stroke();
    doc.moveDown(0.3);
    font(11).text('【品目明細】');
    doc.moveDown(0.3);

    // ヘッダー
    const cols = [40, 240, 320, 390, 460];
    font(10);
    doc.rect(40, doc.y, 515, 18).fillAndStroke('#1B3A2D','#1B3A2D');
    const hy = doc.y+4;
    doc.fillColor('#fff');
    doc.text('品名', cols[0], hy, { width:195 });
    doc.text('数量', cols[1], hy, { width:75 });
    doc.text('単位', cols[2], hy, { width:65 });
    doc.text('備考', cols[3], hy, { width:100 });
    doc.fillColor('#000');
    doc.moveDown(0.2);

    items.forEach((item, i) => {
      const rowY = doc.y;
      if (i%2===0) doc.rect(40, rowY, 515, 18).fill('#f5f5f5');
      doc.fillColor('#000');
      font(10);
      doc.text(item.product_name||'', cols[0], rowY+4, { width:195 });
      doc.text(String(item.quantity||''), cols[1], rowY+4, { width:75 });
      doc.text(item.unit||'', cols[2], rowY+4, { width:65 });
      doc.text('', cols[3], rowY+4, { width:100 });
      doc.moveDown(0.2);
    });

    doc.moveDown(1);
    doc.moveTo(40,doc.y).lineTo(555,doc.y).stroke();
    doc.moveDown(0.5);

    // 担当者・確認印欄
    font(10);
    const signY = doc.y;
    doc.rect(40, signY, 150, 50).stroke();
    doc.text('担当者', 45, signY+5);
    doc.rect(210, signY, 150, 50).stroke();
    doc.text('確認印', 215, signY+5);
    doc.rect(380, signY, 175, 50).stroke();
    doc.text('配送メモ', 385, signY+5);
    doc.moveDown(3.5);

    // 受注番号
    doc.moveDown(0.5);
    font(9).fillColor('#888').text(`受注番号: ${order.order_number}`, { align:'right' });

    doc.end();
    stream.on('finish', () => resolve(filename));
    stream.on('error', reject);
  });
}

/** 「出荷伝票 ORD-XXXXXXXX-001」 */
async function handleGenerateShipment(client, replyToken, orderNumber) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM received_orders WHERE order_number = ?').get(orderNumber);
  if (!order) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text:`受注「${orderNumber}」が見つかりません。` }] });
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id);

  try {
    const filename = await generateShipmentPdf(order, customer);
    const serverUrl = process.env.SERVER_URL || '';
    const pdfMsg = serverUrl
      ? `出荷伝票PDF:\n${serverUrl}/api/shipments/${filename}`
      : '管理画面 → 受注タブからダウンロードできます';

    return client.replyMessage({ replyToken, messages: [{ type:'text',
      text:`📋 出荷伝票を生成しました\n\n受注番号: ${orderNumber}\n顧客: ${order.customer_name}\n\n${pdfMsg}`
    }] });
  } catch(err) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text:`❌ 伝票生成エラー: ${err.message}` }] });
  }
}

module.exports = { handleGenerateShipment, generateShipmentPdf, SHIPMENT_DIR };
