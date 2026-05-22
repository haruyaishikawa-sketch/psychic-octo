'use strict';

require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const path = require('path');

const { handleMessage, handlePostback } = require('./handlers/messageHandler');
const adminRoutes = require('./routes/adminRoutes');
const { registerRichMenu } = require('./line/richMenu');
const { initSheets }  = require('./integrations/sheetsSync');
const { initGmail, sendMonthlyReportEmail } = require('./integrations/gmailSend');
const { sendDailyDeliveryReminder } = require('./handlers/deliveryScheduleHandler');
const cron = require('node-cron');

// ─── LINE クライアント設定 ──────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'DUMMY_TOKEN',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'DUMMY_SECRET',
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

// ─── Express 設定 ───────────────────────────────────────────────
const app = express();
app.set('lineClient', lineClient);

// 静的ファイル（管理画面）
app.use(express.static(path.join(__dirname, '../public')));

// JSON パース（Webhook以外）
app.use('/api', express.json());

// 管理API
app.use('/api', adminRoutes);

// ─── LINE Webhook ───────────────────────────────────────────────
app.post(
  '/webhook',
  line.middleware({ channelSecret: lineConfig.channelSecret }),
  async (req, res) => {
    res.status(200).end(); // LINEへは即200を返す

    const events = req.body.events || [];
    for (const event of events) {
      try {
        if (event.type === 'message') {
          await handleMessage(lineClient, event);
        } else if (event.type === 'postback') {
          await handlePostback(lineClient, event);
        }
      } catch (err) {
        console.error('[Webhook イベント処理エラー]', err);
      }
    }
  }
);

// Webhook 署名検証エラーハンドラ
app.use((err, req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) {
    console.error('[署名検証失敗]', err.message);
    return res.status(401).json({ error: 'Signature validation failed' });
  }
  console.error('[サーバーエラー]', err);
  res.status(500).json({ error: err.message });
});

// ─── 起動 ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, async () => {
  console.log(`\n🌲 材木店LINE連携デモ サーバー起動`);
  console.log(`   URL:     http://localhost:${PORT}`);
  console.log(`   管理画面: http://localhost:${PORT}/`);
  console.log(`   Webhook:  http://localhost:${PORT}/webhook`);
  console.log(`\n   ngrok を使う場合: ngrok http ${PORT}`);
  console.log(`   LINE Webhook URL: https://<ngrok-id>.ngrok-free.app/webhook\n`);

  // リッチメニュー登録（非同期・起動はブロックしない）
  await registerRichMenu(lineConfig.channelAccessToken);

  // Google Sheets / Gmail 初期化
  await initSheets();
  await initGmail();

  // 月次レポート: 毎月1日 8:00 AM に自動送信
  cron.schedule('0 8 1 * *', async () => {
    console.log('[Cron] 月次レポートメール送信...');
    try { await sendMonthlyReportEmail(); }
    catch (err) { console.error('[Cron] 月次レポート送信失敗:', err.message); }
  }, { timezone: 'Asia/Tokyo' });
  console.log('[Cron] 月次レポート スケジュール登録済み（毎月1日 08:00 JST）');

  // 毎朝8時の配達リマインド
  cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] 配達リマインド送信...');
    try { await sendDailyDeliveryReminder(lineClient); }
    catch(err) { console.error('[Cron] 配達リマインド失敗:', err.message); }
  }, { timezone: 'Asia/Tokyo' });
  console.log('[Cron] 配達リマインド スケジュール登録済み（毎日 08:00 JST）');
});

module.exports = app;
