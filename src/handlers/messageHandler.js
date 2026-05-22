'use strict';

const { handleInventoryList, handleProductSearch, handleStockIn, handleStockOut } = require('./inventoryHandler');
const { handleOrderList, handleCreateOrder, handleApproveOrder, handleRejectOrder } = require('./orderHandler');
const {
  handleCreateInvoice,
  handleCreateInvoiceManual,
  handleSendInvoice,
  handleMarkPaidByNumber,
  handleSendInvoiceEmail,
  handleSendMonthlyReport,
  handleUnpaidInvoices,
} = require('./invoiceHandler');
const { handleSetDiscountRate, handleGetDiscountRate, handleCreateQuote } = require('./quoteHandler');
const { handleCreateDeliveryNote } = require('./deliveryHandler');
const { handleCalc } = require('./calcHandler');
const { buildHelpFlex } = require('../line/flexMessages');
const {
  startStockout,
  handleProductSelect,
  handleQuantityInput,
  executeStockout,
  cancelStockout,
} = require('./stockoutFlowHandler');
const {
  startStocktake,
  inputStocktakeItem,
  finishStocktake,
  finishStocktakeForce,
  applyStocktake,
  cancelStocktake,
  showStocktakeHistory,
} = require('./stocktakeHandler');
const { getSession } = require('../sessions/stocktakeSession');

// ─────────────────────────────────────────────────────────────────────
// テキストメッセージハンドラー
// ─────────────────────────────────────────────────────────────────────
async function handleMessage(client, event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const adminLineId = process.env.ADMIN_LINE_USER_ID || '';

  try {
    // ─── セッション中の数量入力（出庫フロー） ──────────────────────────
    const sess = getSession(userId);
    if (sess && sess.type === 'stockout' && sess.step === 'input_quantity') {
      const handled = await handleQuantityInput(client, replyToken, userId, text);
      if (handled) return;
    }

    // ─── 棚卸し入力（「棚卸し [品名] [数量]」形式）──────────────────────
    if (sess && sess.type === 'stocktake' && sess.step === 'in_progress') {
      const stocktakeItemMatch = text.match(/^棚卸し\s+(.+?)\s+(\d+)$/);
      if (stocktakeItemMatch) {
        return await inputStocktakeItem(client, replyToken, userId, stocktakeItemMatch[1].trim(), stocktakeItemMatch[2]);
      }
    }

    // ─── 棚卸し コマンド ──────────────────────────────────────────────
    if (text === '棚卸し開始') {
      return await startStocktake(client, replyToken, userId);
    }
    if (text === '棚卸し完了 強制' || text === '棚卸し完了　強制') {
      return await finishStocktakeForce(client, replyToken, userId);
    }
    if (text === '棚卸し完了') {
      return await finishStocktake(client, replyToken, userId);
    }
    if (text === '棚卸しキャンセル' || text === '棚卸しをキャンセル') {
      return await cancelStocktake(client, replyToken, userId);
    }
    if (text === '棚卸し履歴') {
      return await showStocktakeHistory(client, replyToken);
    }

    // ─── 在庫管理 ──────────────────────────────────────────────────────
    if (text === '在庫確認' || text === '在庫一覧') {
      return await handleInventoryList(client, replyToken);
    }
    const inventorySearch = text.match(/^在庫\s+(.+)$/);
    if (inventorySearch) {
      return await handleProductSearch(client, replyToken, inventorySearch[1].trim());
    }
    const stockInMatch = text.match(/^入庫\s+(.+?)\s+(\d+)/);
    if (stockInMatch) {
      return await handleStockIn(client, replyToken, stockInMatch[1].trim(), parseInt(stockInMatch[2], 10));
    }
    const stockOutMatch = text.match(/^出庫\s+(.+?)\s+(\d+)/);
    if (stockOutMatch) {
      return await handleStockOut(client, replyToken, stockOutMatch[1].trim(), parseInt(stockOutMatch[2], 10), adminLineId);
    }

    // ─── 発注処理 ──────────────────────────────────────────────────────
    if (text === '発注確認' || text === '発注一覧') {
      return await handleOrderList(client, replyToken);
    }
    const orderCreateMatch = text.match(/^発注\s+(.+?)\s+(\d+)[枚本個袋]\s+(.+)$/)
                          || text.match(/^発注\s+(.+?)\s+(\d+)\s+(.+)$/);
    if (orderCreateMatch) {
      return await handleCreateOrder(client, replyToken, orderCreateMatch[1].trim(), parseInt(orderCreateMatch[2], 10), orderCreateMatch[3].trim(), adminLineId);
    }
    const approveMatch = text.match(/^承認\s+(\d+)$/);
    if (approveMatch) return await handleApproveOrder(client, replyToken, parseInt(approveMatch[1], 10));
    const rejectMatch = text.match(/^却下\s+(\d+)$/);
    if (rejectMatch) return await handleRejectOrder(client, replyToken, parseInt(rejectMatch[1], 10));

    // ─── 請求業務 ──────────────────────────────────────────────────────
    // 「請求書作成 田中建設 2024年12月」 or 「請求書作成 田中建設 2024-12」
    const invoiceByMonthMatch = text.match(/^請求書作成\s+(.+?)\s+(\d{4})[年-](\d{1,2})月?$/);
    if (invoiceByMonthMatch) {
      const month = String(invoiceByMonthMatch[3]).padStart(2, '0');
      return await handleCreateInvoice(client, replyToken, invoiceByMonthMatch[1].trim(), `${invoiceByMonthMatch[2]}-${month}`);
    }
    // 「請求書作成 田中建設 杉板 100枚 角材 50本」（手動品目指定）
    const invoiceManualMatch = text.match(/^請求書作成\s+(\S+)\s+(.+)$/);
    if (invoiceManualMatch) {
      return await handleCreateInvoiceManual(client, replyToken, invoiceManualMatch[1].trim(), invoiceManualMatch[2].trim());
    }
    // 「請求書送付 田中建設 2024年12月」
    const invoiceSendMatch = text.match(/^請求書送付\s+(.+?)\s+(\d{4})[年-](\d{1,2})月?$/);
    if (invoiceSendMatch) {
      const month = String(invoiceSendMatch[3]).padStart(2, '0');
      return await handleSendInvoice(client, replyToken, invoiceSendMatch[1].trim(), `${invoiceSendMatch[2]}-${month}`);
    }
    // 「入金確認 INV-20241201-001」
    const markPaidMatch = text.match(/^入金確認\s+(INV-\d{8}-\d{3})$/i);
    if (markPaidMatch) {
      return await handleMarkPaidByNumber(client, replyToken, markPaidMatch[1].toUpperCase());
    }
    // 「請求書メール送付 田中建設 INV-20241201-001」
    const invoiceMailMatch = text.match(/^請求書メール送付\s+(.+?)\s+(INV-\d{8}-\d{3})$/i);
    if (invoiceMailMatch) {
      return await handleSendInvoiceEmail(client, replyToken, invoiceMailMatch[1].trim(), invoiceMailMatch[2].toUpperCase());
    }
    // 「月次レポート送信」
    if (text === '月次レポート送信') {
      return await handleSendMonthlyReport(client, replyToken);
    }
    if (text === '未払い確認' || text === '未払い一覧') {
      return await handleUnpaidInvoices(client, replyToken);
    }

    // ─── 掛け率 ────────────────────────────────────────────────────────
    const setRateMatch = text.match(/^掛け率\s+(.+?)\s+(0\.\d+|1\.0|1)$/);
    if (setRateMatch) {
      return await handleSetDiscountRate(client, replyToken, setRateMatch[1].trim(), parseFloat(setRateMatch[2]));
    }
    const getRateMatch = text.match(/^掛け率\s+(.+)$/);
    if (getRateMatch) {
      return await handleGetDiscountRate(client, replyToken, getRateMatch[1].trim());
    }

    // ─── 見積書 ────────────────────────────────────────────────────────
    const quoteMatch = text.match(/^見積書\s+(.+?)\s+(.+?)\s+(\d+)/);
    if (quoteMatch) {
      return await handleCreateQuote(
        client, replyToken,
        quoteMatch[1].trim(),
        quoteMatch[2].trim(),
        parseInt(quoteMatch[3], 10)
      );
    }

    // ─── 納品書 ────────────────────────────────────────────────────────
    const deliveryMatch = text.match(/^納品書\s+(.+?)\s+(.+?)\s+(\d+)/);
    if (deliveryMatch) {
      return await handleCreateDeliveryNote(
        client, replyToken,
        deliveryMatch[1].trim(),
        deliveryMatch[2].trim(),
        parseInt(deliveryMatch[3], 10)
      );
    }

    // ─── 材積計算 ──────────────────────────────────────────────────────
    const calcMatch = text.match(/^(?:材積計算|材積|ざいせき)\s+(.+)$/);
    if (calcMatch) {
      const args = calcMatch[1].trim().split(/\s+/);
      return await handleCalc(client, replyToken, args);
    }

    // ─── ヘルプ ────────────────────────────────────────────────────────
    if (text === 'ヘルプ' || text === 'help' || text === 'メニュー') {
      return await client.replyMessage({ replyToken, messages: [buildHelpFlex()] });
    }

    // ─── 未認識 ────────────────────────────────────────────────────────
    await client.replyMessage({
      replyToken,
      messages: [{
        type: 'text',
        text: `コマンドが認識できませんでした。「ヘルプ」と送信すると操作メニューを表示します。\n\n主なコマンド:\n・在庫確認 / 入庫 / 出庫\n・発注確認 / 発注\n・見積書 [顧客] [品名] [数量]\n・納品書 [顧客] [品名] [数量]\n・請求書作成 [顧客] [年月]\n・請求書作成 [顧客] [品名] [数量]...\n・請求書送付 [顧客] [年月]\n・入金確認 INV-YYYYMMDD-NNN\n・掛け率 [顧客] [掛け率]\n・材積 [縦] [横] [長さ] [本数]\n・未払い確認\n・棚卸し開始 / 棚卸し完了 / 棚卸し履歴`,
      }],
    });
  } catch (err) {
    console.error('[messageHandler エラー]', err);
    try {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: `エラーが発生しました: ${err.message}` }] });
    } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────
// Postbackイベントハンドラー
// ─────────────────────────────────────────────────────────────────────
async function handlePostback(client, event) {
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const data = event.postback.data; // e.g. "action=stockout_start"

  const params = Object.fromEntries(new URLSearchParams(data));
  const action = params.action;

  try {
    switch (action) {
      // ─── 出庫フロー ────────────────────────────────────────────────
      case 'stockout_start':
        return await startStockout(client, replyToken, userId);

      case 'stockout_select':
        return await handleProductSelect(client, replyToken, userId, params.productId);

      case 'stockout_execute':
        return await executeStockout(client, replyToken, userId);

      case 'stockout_cancel':
        return await cancelStockout(client, replyToken, userId);

      // ─── 入庫ガイド ────────────────────────────────────────────────
      case 'stockin_guide':
        return await client.replyMessage({ replyToken, messages: [{
          type: 'text',
          text: '⬆️ 入庫コマンド:\n「入庫 [品名キーワード] [数量]」\n\n例:\n・入庫 杉板 100\n・入庫 2×4 50\n\n品名の一部（キーワード）を入力するだけで検索します。',
        }]});

      // ─── 棚卸しフロー ──────────────────────────────────────────────
      case 'stocktake_apply':
        return await applyStocktake(client, replyToken, userId);

      case 'stocktake_cancel':
        return await cancelStocktake(client, replyToken, userId);

      default:
        return await client.replyMessage({ replyToken, messages: [{ type: 'text', text: `不明なアクション: ${action}` }] });
    }
  } catch (err) {
    console.error('[handlePostback エラー]', err);
    try {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: `エラーが発生しました: ${err.message}` }] });
    } catch (_) {}
  }
}

module.exports = { handleMessage, handlePostback };
