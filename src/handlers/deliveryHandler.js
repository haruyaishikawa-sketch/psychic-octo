'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getDb } = require('../db/database');

const PDF_DIR = path.join(__dirname, '../../invoices');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

const FONT_PATH = path.join(__dirname, '../../fonts/NotoSansJP-Regular.ttf');
const HAS_FONT = fs.existsSync(FONT_PATH);

// 納品書作成（LINE コマンド: 納品書 田中建設 杉板2×4 30枚）
async function handleCreateDeliveryNote(client, replyToken, customerName, productKeyword, quantity) {
  const db = getDb();

  const customer = db.prepare('SELECT * FROM customers WHERE company_name LIKE ?').get(`%${customerName}%`);
  if (!customer) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `「${customerName}」に一致する顧客が見つかりませんでした。` }],
    });
    return;
  }

  const product = db
    .prepare('SELECT * FROM products WHERE (name || spec) LIKE ? OR (name || " " || spec) LIKE ?')
    .get(`%${productKeyword}%`, `%${productKeyword}%`);
  if (!product) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `「${productKeyword}」に一致する品目が見つかりませんでした。` }],
    });
    return;
  }

  // 在庫チェック
  if (product.stock < quantity) {
    await client.replyMessage({
      replyToken,
      messages: [{
        type: 'text',
        text: `⚠️ 在庫不足\n\n現在庫: ${product.stock}${product.unit}\n納品要求: ${quantity}${product.unit}\n\n在庫が足りません。発注後に再度お試しください。`,
      }],
    });
    return;
  }

  const rate = customer.discount_rate;
  const discountedPrice = Math.round(product.unit_price * rate);
  const amount = discountedPrice * quantity;

  const items = [
    {
      product_name: `${product.name} ${product.spec}`,
      quantity,
      unit_price: product.unit_price,
      discounted_price: discountedPrice,
      amount,
    },
  ];

  const deliveredAt = new Date().toISOString().split('T')[0];

  // DB保存
  const result = db.prepare(`
    INSERT INTO delivery_notes (customer_id, customer_name, items, total_amount, delivered_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(customer.id, customer.company_name, JSON.stringify(items), amount, deliveredAt);

  const note = db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(Number(result.lastInsertRowid));

  // 在庫を出庫
  const newStock = product.stock - quantity;
  db.prepare('UPDATE products SET stock = ?, updated_at = datetime("now","localtime") WHERE id = ?').run(newStock, product.id);

  // PDF 生成
  let pdfResult;
  try {
    pdfResult = await generateDeliveryPdf(note, items, customer);
    db.prepare('UPDATE delivery_notes SET pdf_path = ? WHERE id = ?').run(pdfResult.filename, note.id);
  } catch (err) {
    console.error('[納品書PDF生成エラー]', err);
  }

  const adminLineId = process.env.ADMIN_LINE_USER_ID || '';
  const isAlert = newStock <= product.reorder_point;

  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'flex',
        altText: `納品書 #${note.id} を作成しました`,
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: '🚚 納品書を作成しました', weight: 'bold', color: '#FFFFFF', size: 'md' },
            ],
            backgroundColor: '#2E7D32',
            paddingAll: 'md',
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              kv('納品番号', `#${String(note.id).padStart(5, '0')}`),
              kv('顧客',     customer.company_name),
              kv('品名',     `${product.name} ${product.spec}`),
              kv('数量',     `${quantity}${product.unit}`),
              kv('単価',     `¥${discountedPrice.toLocaleString()} (掛け率 ${rate})`),
              kv('金額',     `¥${amount.toLocaleString()}`, true),
              { type: 'separator', margin: 'md' },
              kv('納品日',   deliveredAt),
              kv('出庫後在庫', `${newStock}${product.unit}${isAlert ? ' ⚠️' : ''}`),
            ],
            paddingAll: 'md',
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: 'PDFは管理画面からダウンロードできます', size: 'xs', color: '#888888', align: 'center' },
            ],
            paddingAll: 'sm',
          },
        },
      },
    ],
  });

  // 在庫アラート通知
  if (isAlert && adminLineId) {
    try {
      await client.pushMessage({
        to: adminLineId,
        messages: [{
          type: 'text',
          text: `🚨 在庫アラート（納品後）\n\n${product.name} ${product.spec} の在庫が発注点以下になりました。\n現在庫: ${newStock}${product.unit} / 発注点: ${product.reorder_point}${product.unit}`,
        }],
      });
    } catch (e) {
      console.error('[アラート送信エラー]', e.message);
    }
  }
}

// 納品書PDF生成
function generateDeliveryPdf(note, items, customer) {
  return new Promise((resolve, reject) => {
    const filename = `delivery_${note.id}_${note.delivered_at}.pdf`;
    const filepath = path.join(PDF_DIR, filename);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    if (HAS_FONT) doc.font(FONT_PATH);

    // タイトル
    doc.fontSize(24).text('納 品 書', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10)
      .text(`No. D-${String(note.id).padStart(5, '0')}`, { align: 'right' })
      .text(`納品日: ${note.delivered_at}`, { align: 'right' });
    doc.moveDown(0.8);

    // 宛先
    doc.fontSize(14).text(`${customer.company_name} 御中`);
    doc.fontSize(10).text(`担当: ${customer.contact_person || ''}`, { indent: 10 });
    doc.moveDown(0.8);

    // 発行元
    doc.fontSize(10)
      .text('発行元: 〇〇材木店', { align: 'right' })
      .text('TEL: 00-0000-0000', { align: 'right' });
    doc.moveDown(0.5);

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    // 明細ヘッダー
    const hY = doc.y;
    doc.fontSize(10).text('品名・規格', 50, hY, { width: 220 });
    doc.text('数量', 280, hY, { width: 70, align: 'right' });
    doc.text('単価（掛け値）', 360, hY, { width: 90, align: 'right' });
    doc.text('金額', 460, hY, { width: 85, align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    // 明細行
    for (const item of items) {
      const ry = doc.y;
      doc.text(item.product_name, 50, ry, { width: 220 });
      doc.text(String(item.quantity), 280, ry, { width: 70, align: 'right' });
      doc.text(`¥${item.discounted_price.toLocaleString()}`, 360, ry, { width: 90, align: 'right' });
      doc.text(`¥${item.amount.toLocaleString()}`, 460, ry, { width: 85, align: 'right' });
      doc.moveDown(0.4);
    }

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    doc.fontSize(13)
      .text('合計金額（税抜）', 320)
      .moveUp()
      .text(`¥${note.total_amount.toLocaleString()}`, { align: 'right' });

    doc.moveDown(2);
    doc.fontSize(10)
      .text('上記の通り納品いたしました。')
      .moveDown()
      .text('ご確認の上、ご署名・ご捺印をお願いいたします。')
      .moveDown(2);

    // 確認欄
    doc.text('受領印:', 350).moveTo(410, doc.y + 5).lineTo(545, doc.y + 5).stroke();
    doc.moveDown(3);
    doc.rect(350, doc.y - 60, 195, 60).stroke();

    doc.end();
    stream.on('finish', () => resolve({ filepath, filename }));
    stream.on('error', reject);
  });
}

module.exports = { handleCreateDeliveryNote, generateDeliveryPdf, PDF_DIR };

function kv(label, value, bold = false) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#888888', flex: 3 },
      { type: 'text', text: value, size: 'sm', color: '#222222', flex: 5, wrap: true, weight: bold ? 'bold' : 'regular' },
    ],
  };
}
