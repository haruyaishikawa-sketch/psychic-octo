'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getDb } = require('../db/database');

const PDF_DIR = path.join(__dirname, '../../invoices');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

const FONT_PATH = path.join(__dirname, '../../fonts/NotoSansJP-Regular.ttf');
const HAS_FONT = fs.existsSync(FONT_PATH);

// 掛け率の設定
async function handleSetDiscountRate(client, replyToken, customerName, rate) {
  const db = getDb();

  if (isNaN(rate) || rate <= 0 || rate > 1) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '掛け率は 0.01〜1.00 の範囲で入力してください。\n例: 掛け率 田中建設 0.85' }],
    });
    return;
  }

  const customer = db.prepare('SELECT * FROM customers WHERE company_name LIKE ?').get(`%${customerName}%`);
  if (!customer) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `「${customerName}」に一致する顧客が見つかりませんでした。` }],
    });
    return;
  }

  db.prepare('UPDATE customers SET discount_rate = ? WHERE id = ?').run(rate, customer.id);

  const discountPct = Math.round((1 - rate) * 100);
  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: `✅ 掛け率を更新しました\n\n顧客: ${customer.company_name}\n掛け率: ${rate} (${discountPct}% 引き)\n\n次回の見積書・請求書に適用されます。`,
      },
    ],
  });
}

// 掛け率の確認
async function handleGetDiscountRate(client, replyToken, customerName) {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE company_name LIKE ?').get(`%${customerName}%`);
  if (!customer) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `「${customerName}」に一致する顧客が見つかりませんでした。` }],
    });
    return;
  }
  const discountPct = Math.round((1 - customer.discount_rate) * 100);
  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: `📊 ${customer.company_name} の掛け率\n\n掛け率: ${customer.discount_rate} (${discountPct}% 引き)\n\n変更: 掛け率 ${customer.company_name} [新しい掛け率]`,
      },
    ],
  });
}

// 見積書作成（LINE コマンド: 見積書 田中建設 杉板2×4 50枚）
async function handleCreateQuote(client, replyToken, customerName, productKeyword, quantity) {
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

  const rate = customer.discount_rate;
  const discountedPrice = Math.round(product.unit_price * rate);
  const amount = discountedPrice * quantity;
  const tax = Math.floor(amount * 0.1);
  const grandTotal = amount + tax;

  const items = [
    {
      product_name: `${product.name} ${product.spec}`,
      quantity,
      unit_price: product.unit_price,
      discounted_price: discountedPrice,
      amount,
    },
  ];

  // 有効期限: 発行から30日後
  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + 30);
  const validUntilStr = validUntil.toISOString().split('T')[0];

  const result = db.prepare(`
    INSERT INTO quotes (customer_id, customer_name, items, subtotal, discount_rate, total_amount, tax_amount, grand_total, status, valid_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
  `).run(customer.id, customer.company_name, JSON.stringify(items), amount, rate, amount, tax, grandTotal, validUntilStr);

  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(result.lastInsertRowid));

  // PDF 生成
  let pdfResult;
  try {
    pdfResult = await generateQuotePdf(quote, items, customer);
    db.prepare('UPDATE quotes SET pdf_path = ? WHERE id = ?').run(pdfResult.filename, quote.id);
  } catch (err) {
    console.error('[見積PDF生成エラー]', err);
  }

  const discountPct = Math.round((1 - rate) * 100);
  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'flex',
        altText: `見積書 #${quote.id} を作成しました`,
        contents: {
          type: 'bubble',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: '📄 見積書を作成しました', weight: 'bold', color: '#FFFFFF', size: 'md' },
            ],
            backgroundColor: '#1565C0',
            paddingAll: 'md',
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              kv('見積番号',  `#${String(quote.id).padStart(5,'0')}`),
              kv('顧客',      customer.company_name),
              kv('品名',      `${product.name} ${product.spec}`),
              kv('数量',      `${quantity}${product.unit}`),
              kv('定価',      `¥${product.unit_price.toLocaleString()} / ${product.unit}`),
              kv('掛け率',    `${rate} (${discountPct}%引き)`),
              kv('掛け値',    `¥${discountedPrice.toLocaleString()} / ${product.unit}`),
              { type: 'separator', margin: 'md' },
              kv('小計',      `¥${amount.toLocaleString()}`),
              kv('消費税(10%)', `¥${tax.toLocaleString()}`),
              kv('合計',      `¥${grandTotal.toLocaleString()}`, true),
              { type: 'separator', margin: 'md' },
              kv('有効期限',  validUntilStr),
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
}

// 見積書 PDF 生成
function generateQuotePdf(quote, items, customer) {
  return new Promise((resolve, reject) => {
    const filename = `quote_${quote.id}_${new Date().toISOString().slice(0,10)}.pdf`;
    const filepath = path.join(PDF_DIR, filename);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    if (HAS_FONT) doc.font(FONT_PATH);

    // タイトル
    doc.fontSize(24).text('御 見 積 書', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10)
      .text(`No. Q-${String(quote.id).padStart(5, '0')}`, { align: 'right' })
      .text(`発行日: ${new Date().toISOString().split('T')[0]}`, { align: 'right' })
      .text(`有効期限: ${quote.valid_until}`, { align: 'right' });
    doc.moveDown(0.8);

    // 宛先
    doc.fontSize(14).text(`${customer.company_name} 御中`);
    doc.fontSize(10).text(`担当: ${customer.contact_person || ''}`, { indent: 10 });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`掛け率: ${quote.discount_rate}（定価より ${Math.round((1 - quote.discount_rate) * 100)}% 引き）`);
    doc.moveDown(0.8);

    // 発行元
    doc.fontSize(10).text('発行元: 〇〇材木店', { align: 'right' }).text('TEL: 00-0000-0000', { align: 'right' });
    doc.moveDown(0.5);

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    // 明細ヘッダー
    const y = doc.y;
    doc.fontSize(10).text('品名・規格', 50, y, { width: 200 });
    doc.text('数量', 260, y, { width: 50, align: 'right' });
    doc.text('定価', 320, y, { width: 70, align: 'right' });
    doc.text('掛け値', 400, y, { width: 70, align: 'right' });
    doc.text('金額', 480, y, { width: 65, align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    // 明細行
    for (const item of items) {
      const ry = doc.y;
      doc.text(item.product_name, 50, ry, { width: 200 });
      doc.text(String(item.quantity), 260, ry, { width: 50, align: 'right' });
      doc.text(`¥${item.unit_price.toLocaleString()}`, 320, ry, { width: 70, align: 'right' });
      doc.text(`¥${item.discounted_price.toLocaleString()}`, 400, ry, { width: 70, align: 'right' });
      doc.text(`¥${item.amount.toLocaleString()}`, 480, ry, { width: 65, align: 'right' });
      doc.moveDown(0.4);
    }

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    const tax = quote.tax_amount;
    doc.text('小計', 380).moveUp().text(`¥${quote.subtotal.toLocaleString()}`, { align: 'right' });
    doc.moveDown(0.3);
    doc.text('消費税（10%）', 380).moveUp().text(`¥${tax.toLocaleString()}`, { align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(380, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);
    doc.fontSize(13).text('お見積合計', 340).moveUp().text(`¥${quote.grand_total.toLocaleString()}`, { align: 'right' });

    doc.moveDown(2);
    doc.fontSize(10)
      .text('※ 本見積書の有効期限は発行日より30日間です。')
      .text('※ 上記金額は消費税10%込みです。')
      .moveDown()
      .text('ご不明な点はお気軽にお問い合わせください。');

    doc.end();
    stream.on('finish', () => resolve({ filepath, filename }));
    stream.on('error', reject);
  });
}

const PDF_DIR_QUOTE = PDF_DIR;

module.exports = {
  handleSetDiscountRate,
  handleGetDiscountRate,
  handleCreateQuote,
  generateQuotePdf,
  PDF_DIR_QUOTE,
};

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
