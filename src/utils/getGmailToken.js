#!/usr/bin/env node
'use strict';

/**
 * Gmail OAuth2 リフレッシュトークン取得ユーティリティ
 *
 * 使い方:
 *   node src/utils/getGmailToken.js
 *
 * 1. 表示された認証URLをブラウザで開く
 * 2. Googleアカウントでログインして許可する
 * 3. リダイレクト先のURLに含まれる code= 以降をコピーしてコンソールに入力
 * 4. 表示されたリフレッシュトークンを .env の GMAIL_REFRESH_TOKEN に設定する
 *
 * 事前準備:
 *   .env に GMAIL_CLIENT_ID と GMAIL_CLIENT_SECRET を設定してください。
 *   または以下の環境変数を直接指定してください:
 *     GMAIL_CLIENT_ID=xxxx GMAIL_CLIENT_SECRET=yyyy node src/utils/getGmailToken.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const readline = require('readline');
const { google } = require('googleapis');

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI  = 'urn:ietf:wg:oauth:2.0:oob'; // コンソール入力方式

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ GMAIL_CLIENT_ID と GMAIL_CLIENT_SECRET を .env に設定してください。');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// 必要なスコープ（Gmail 送信のみ）
const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // 毎回リフレッシュトークンを発行するため
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Gmail OAuth2 リフレッシュトークン取得ツール');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('\n手順:');
console.log('  1. 以下のURLをブラウザで開いてください');
console.log('  2. Googleアカウントでログインして許可してください');
console.log('  3. 表示された「認証コード」をこのコンソールに入力してください\n');
console.log('【認証URL】');
console.log(authUrl);
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('認証コードを入力してください: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ✅ トークン取得成功！');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n以下を .env に設定してください:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('');
    if (!tokens.refresh_token) {
      console.warn('⚠️  リフレッシュトークンが取得できませんでした。');
      console.warn('   Google Cloud Console で一度アクセスを取り消してから再実行してください。');
      console.warn('   https://myaccount.google.com/permissions');
    }
  } catch (err) {
    console.error('\n❌ トークン取得失敗:', err.message);
    console.error('   認証コードが正しいか確認してください。');
    process.exit(1);
  }
});
