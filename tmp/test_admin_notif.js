const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_TELEGRAM_ID || '7606795944';

if (!token) {
    console.error('BOT_TOKEN is missing in .env');
    process.exit(1);
}

const bot = new Telegraf(token);

async function testSend() {
    console.log(`Trying to send test message to ${adminId} using token ${token.substring(0, 5)}...`);
    try {
        const res = await bot.telegram.sendMessage(adminId, '🔔 <b>TEST NOTIFICATION</b>\n\nCeci est un test de notification admin.', { parse_mode: 'HTML' });
        console.log('✅ Success! Message ID:', res.message_id);
    } catch (e) {
        console.error('❌ Failed:', e.message);
        if (e.message.includes('bot was blocked')) {
            console.log('TIP: The user has blocked the bot or never started it.');
        } else if (e.message.includes('chat not found')) {
            console.log('TIP: The bot has never interacted with this user.');
        }
    }
}

testSend();
