'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { PDF_DIR } = require('../handlers/invoiceHandler');
const { PDF_DIR_QUOTE } = require('../handlers/quoteHandler');

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
    const query = status
      ? 'SELECT * FROM invoices WHERE status = ? ORDER BY billing_month DESC'
      : 'SELECT * FROM invoices ORDER BY billing_month DESC';
    const invoices = status
      ? db.prepare(query).all(status)
      : db.prepare(query).all();
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

module.exports = router;
