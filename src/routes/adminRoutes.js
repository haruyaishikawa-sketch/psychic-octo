'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { PDF_DIR, generateInvoicePdf } = require('../handlers/invoiceHandler');
const { PDF_DIR_QUOTE } = require('../handlers/quoteHandler');
const { PO_DIR, generatePurchaseOrderPdf } = require('../handlers/purchaseOrderHandler');
const sheets = require('../integrations/sheetsSync');

const router = express.Router();

// ─── 在庫 ──────────────────────────────────────────────────────────

router.get('/products', (req, res) => {
  try {
    const db = getDb();
    const products = db.prepare('SELECT * FROM products ORDER BY id').all();
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/products/:id/stock', (req, res) => {
  try {
    const db = getDb();
    const { delta } = req.body; // 正: 入庫, 負: 出庫
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ success: false, error: '品目が見つかりません' });

    const newStock = product.stock + parseInt(delta, 10);
    if (newStock < 0) return res.status(400).json({ success: false, error: '在庫がマイナスになります' });

    db.prepare('UPDATE products SET stock = ?, updated_at = datetime("now","localtime") WHERE id = ?').run(newStock, product.id);
    res.json({ success: true, data: { id: product.id, stock: newStock } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 発注 ──────────────────────────────────────────────────────────

router.get('/orders', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    const query = status
      ? 'SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM orders ORDER BY created_at DESC';
    const orders = status
      ? db.prepare(query).all(status)
      : db.prepare(query).all();
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 発注書PDF ダウンロード
router.get('/orders/:id/purchase-order/pdf', (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: '発注が見つかりません' });
    if (!order.purchase_order_path) {
      return res.status(404).json({ success: false, error: '発注書PDFがありません。承認処理を行うと自動生成されます。' });
    }
    if (!fs.existsSync(order.purchase_order_path)) {
      return res.status(404).json({ success: false, error: 'PDFファイルが存在しません' });
    }
    res.download(order.purchase_order_path, path.basename(order.purchase_order_path));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 発注書メール再送
router.post('/orders/:id/purchase-order/resend', async (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: '発注が見つかりません' });

    const supplier = order.supplier_id
      ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(order.supplier_id))
      : null;

    if (!supplier || !supplier.email) {
      return res.status(400).json({ success: false, error: '仕入先のメールアドレスが登録されていません' });
    }

    // PDF生成（再生成）
    const { pdfPath, poNumber } = await generatePurchaseOrderPdf(order, supplier);

    // DBにパスを保存
    try {
      db.prepare(
        "UPDATE orders SET purchase_order_path = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(pdfPath, order.id);
    } catch (_) { /* カラム未存在は無視 */ }

    const gmail = require('../integrations/gmailSend');
    const sent = await gmail.sendPurchaseOrderEmail(order.supplier_id, order, pdfPath);

    if (sent) {
      try {
        db.prepare(
          "UPDATE orders SET email_sent = 1, email_sent_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?"
        ).run(order.id);
      } catch (_) { /* カラム未存在は無視 */ }
      res.json({ success: true, data: { message: `${supplier.company_name}（${supplier.email}）に発注書メールを再送しました`, poNumber } });
    } else {
      res.status(500).json({ success: false, error: 'Gmail連携が設定されていません。.envのGmail設定を確認してください。' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/orders/:id/status', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ success: false, error: '無効なステータスです' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: '発注が見つかりません' });

    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, order.id);
    res.json({ success: true, data: { id: order.id, status } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 請求書 ────────────────────────────────────────────────────────

router.get('/invoices', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    // customer_email を JOIN して返す
    const baseQuery = `
      SELECT i.*, c.email as customer_email
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      ${status ? 'WHERE i.status = ?' : ''}
      ORDER BY i.billing_month DESC
    `;
    const invoices = status
      ? db.prepare(baseQuery).all(status)
      : db.prepare(baseQuery).all();
    res.json({ success: true, data: invoices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/invoices/:id/status', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;
    if (!['paid', 'unpaid'].includes(status)) {
      return res.status(400).json({ success: false, error: '無効なステータスです' });
    }
    db.prepare("UPDATE invoices SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, req.params.id);
    res.json({ success: true, data: { id: req.params.id, status } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PDF ダウンロード
router.get('/invoices/:id/pdf', (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice || !invoice.pdf_path) {
      return res.status(404).json({ success: false, error: 'PDFが見つかりません。先にLINEで請求書を生成してください。' });
    }
    const pdfPath = path.join(PDF_DIR, invoice.pdf_path);
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ success: false, error: 'PDFファイルが存在しません' });
    }
    res.download(pdfPath, invoice.pdf_path);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// LINE送付
router.post('/invoices/:id/send', async (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: '請求書が見つかりません' });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
    if (!customer || !customer.line_user_id) {
      return res.status(400).json({ success: false, error: `${invoice.customer_name} のLINEユーザーIDが登録されていません` });
    }

    // PDFがなければ生成
    let pdfFilename = invoice.pdf_path;
    if (!pdfFilename || !fs.existsSync(path.join(PDF_DIR, pdfFilename))) {
      const items = JSON.parse(invoice.items || '[]');
      pdfFilename = await generateInvoicePdf(invoice, items, customer);
      db.prepare("UPDATE invoices SET pdf_path = ?, updated_at = datetime('now','localtime') WHERE id = ?")
        .run(pdfFilename, invoice.id);
    }

    const lineClient = req.app.get('lineClient');
    const serverUrl = process.env.SERVER_URL || '';
    const pdfUrl = serverUrl ? `${serverUrl}/api/invoices/${invoice.id}/pdf` : null;

    const msgText = [
      `📄 請求書をお送りします`,
      `請求書番号: ${invoice.invoice_number}`,
      `対象月: ${invoice.billing_month}`,
      `合計金額: ¥${invoice.total_amount.toLocaleString()}`,
      `お支払期限: ${invoice.due_date || '—'}`,
      pdfUrl ? `\nPDF: ${pdfUrl}` : '\n※PDFはメールにて別途お送りします',
    ].join('\n');

    await lineClient.pushMessage({ to: customer.line_user_id, messages: [{ type: 'text', text: msgText }] });
    res.json({ success: true, data: { message: `${invoice.customer_name} に送付しました` } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// メール送付（管理画面から）
router.post('/invoices/:id/send-email', async (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: '請求書が見つかりません' });

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
    if (!customer || !customer.email) {
      return res.status(400).json({ success: false, error: `${invoice.customer_name} のメールアドレスが未登録です。顧客・掛け率タブで登録してください。` });
    }

    // PDFがなければ生成
    let pdfFilename = invoice.pdf_path;
    if (!pdfFilename || !fs.existsSync(path.join(PDF_DIR, pdfFilename))) {
      const items = JSON.parse(invoice.items || '[]');
      pdfFilename = await generateInvoicePdf({ ...invoice }, items, customer);
      db.prepare("UPDATE invoices SET pdf_path = ?, updated_at = datetime('now','localtime') WHERE id = ?")
        .run(pdfFilename, invoice.id);
    }

    const gmail = require('../integrations/gmailSend');
    const pdfPath = path.join(PDF_DIR, pdfFilename);
    const sent = await gmail.sendInvoiceEmail(invoice.customer_id, pdfPath, { ...invoice, pdf_path: pdfFilename });

    if (sent) {
      res.json({ success: true, data: { message: `${customer.company_name}（${customer.email}）に送付しました` } });
    } else {
      res.status(500).json({ success: false, error: 'Gmail連携が設定されていません。.envのGmail設定を確認してください。' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 入金確認（PUT）
router.put('/invoices/:id/payment', (req, res) => {
  try {
    const db = getDb();
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, error: '請求書が見つかりません' });

    db.prepare("UPDATE invoices SET status = 'paid', updated_at = datetime('now','localtime') WHERE id = ?")
      .run(req.params.id);

    // Sheets 同期
    sheets.runAsync(sheets.updateInvoicePayment, Number(req.params.id));

    res.json({ success: true, data: { id: req.params.id, status: 'paid' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 見積書 ────────────────────────────────────────────────────────

router.get('/quotes', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    const quotes = status
      ? db.prepare('SELECT * FROM quotes WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT * FROM quotes ORDER BY created_at DESC').all();
    res.json({ success: true, data: quotes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/quotes/:id/status', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;
    if (!['draft', 'sent', 'accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: '無効なステータスです' });
    }
    db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, req.params.id);
    res.json({ success: true, data: { id: req.params.id, status } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/quotes/:id/pdf', (req, res) => {
  try {
    const db = getDb();
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
    if (!quote || !quote.pdf_path) {
      return res.status(404).json({ success: false, error: 'PDFが見つかりません。先にLINEで見積書を生成してください。' });
    }
    const pdfPath = path.join(PDF_DIR_QUOTE, quote.pdf_path);
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ success: false, error: 'PDFファイルが存在しません' });
    }
    res.download(pdfPath, quote.pdf_path);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 納品書 ────────────────────────────────────────────────────────

router.get('/delivery-notes', (req, res) => {
  try {
    const db = getDb();
    const notes = db.prepare('SELECT * FROM delivery_notes ORDER BY created_at DESC').all();
    res.json({ success: true, data: notes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/delivery-notes/:id/pdf', (req, res) => {
  try {
    const db = getDb();
    const note = db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(req.params.id);
    if (!note || !note.pdf_path) {
      return res.status(404).json({ success: false, error: 'PDFが見つかりません。先にLINEで納品書を生成してください。' });
    }
    const pdfPath = path.join(PDF_DIR, note.pdf_path);
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ success: false, error: 'PDFファイルが存在しません' });
    }
    res.download(pdfPath, note.pdf_path);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 顧客・仕入先 ────────────────────────────────────────────────

router.get('/customers', (req, res) => {
  try {
    const db = getDb();
    res.json({ success: true, data: db.prepare('SELECT * FROM customers ORDER BY id').all() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 掛け率更新
router.patch('/customers/:id/discount-rate', (req, res) => {
  try {
    const db = getDb();
    const { discount_rate } = req.body;
    const rate = parseFloat(discount_rate);
    if (isNaN(rate) || rate <= 0 || rate > 1) {
      return res.status(400).json({ success: false, error: '掛け率は 0.01〜1.00 の範囲で指定してください' });
    }
    db.prepare('UPDATE customers SET discount_rate = ? WHERE id = ?').run(rate, req.params.id);
    res.json({ success: true, data: { id: req.params.id, discount_rate: rate } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// メールアドレス更新
router.put('/customers/:id/email', (req, res) => {
  try {
    const db = getDb();
    const { email } = req.body;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: '無効なメールアドレス形式です' });
    }
    db.prepare('UPDATE customers SET email = ? WHERE id = ?').run(email || null, req.params.id);
    res.json({ success: true, data: { id: req.params.id, email: email || null } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/suppliers', (req, res) => {
  try {
    const db = getDb();
    res.json({ success: true, data: db.prepare('SELECT * FROM suppliers').all() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 棚卸し履歴 ──────────────────────────────────────────────────

router.get('/adjustments', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, adjusted_at, product_id, product_name, system_stock, actual_stock, diff, adjuster_line_id
      FROM inventory_adjustments
      ORDER BY adjusted_at DESC
      LIMIT 100
    `).all();
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LINEテストメッセージ送信 ──────────────────────────────────

router.post('/line/test-push', async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ success: false, error: 'userId と message が必要です' });
    }

    const lineClient = req.app.get('lineClient');
    if (!lineClient) {
      return res.status(503).json({ success: false, error: 'LINEクライアントが初期化されていません' });
    }

    await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: message }] });
    res.json({ success: true, message: '送信しました' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ダッシュボード集計 ─────────────────────────────────────────

router.get('/dashboard', (req, res) => {
  try {
    const db = getDb();
    const totalProducts = db.prepare('SELECT COUNT(*) as cnt FROM products').get().cnt;
    const alertProducts = db.prepare('SELECT COUNT(*) as cnt FROM products WHERE stock <= reorder_point').get().cnt;
    const pendingOrders = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'pending'").get().cnt;
    const unpaidAmount  = db.prepare("SELECT COALESCE(SUM(total_amount),0) as total FROM invoices WHERE status = 'unpaid'").get().total;
    const unpaidCount   = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE status = 'unpaid'").get().cnt;
    const draftQuotes   = db.prepare("SELECT COUNT(*) as cnt FROM quotes WHERE status = 'draft'").get().cnt;

    res.json({
      success: true,
      data: { totalProducts, alertProducts, pendingOrders, unpaidAmount, unpaidCount, draftQuotes },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 受注管理 ────────────────────────────────────────────────────────

router.get('/orders/received', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    const orders = status
      ? db.prepare('SELECT * FROM received_orders WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT * FROM received_orders ORDER BY created_at DESC').all();
    res.json({ success:true, data:orders });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

router.get('/orders/received/:id', (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM received_orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success:false, error:'受注が見つかりません' });
    res.json({ success:true, data:order });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

router.put('/orders/received/:id/status', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;
    const validStatuses = ['受注済','出庫済','配達済','請求済','完了'];
    if (!validStatuses.includes(status)) return res.status(400).json({ success:false, error:'無効なステータスです' });
    db.prepare("UPDATE received_orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(status, req.params.id);
    res.json({ success:true, data:{ id:req.params.id, status } });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

// ─── 配送管理 ────────────────────────────────────────────────────────

router.get('/deliveries', (req, res) => {
  try {
    const db = getDb();
    const { date } = req.query;
    const deliveries = date
      ? db.prepare('SELECT * FROM deliveries WHERE delivery_date = ? ORDER BY time_slot').all(date)
      : db.prepare("SELECT * FROM deliveries WHERE delivery_date >= date('now','localtime','-1 day') ORDER BY delivery_date, time_slot LIMIT 30").all();
    res.json({ success:true, data:deliveries });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

router.put('/deliveries/:id/complete', (req, res) => {
  try {
    const db = getDb();
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
    if (!delivery) return res.status(404).json({ success:false, error:'配送が見つかりません' });
    db.prepare("UPDATE deliveries SET status='完了', updated_at=datetime('now','localtime') WHERE id=?").run(req.params.id);
    db.prepare("UPDATE received_orders SET status='配達済', updated_at=datetime('now','localtime') WHERE order_number=?").run(delivery.order_number);
    res.json({ success:true, data:{ id:req.params.id, status:'完了' } });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

// 出荷伝票PDF
router.get('/shipments/:filename', (req, res) => {
  try {
    const { SHIPMENT_DIR } = require('../handlers/shipmentHandler');
    const filePath = path.join(SHIPMENT_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success:false, error:'ファイルが見つかりません' });
    res.download(filePath, req.params.filename);
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

module.exports = router;
