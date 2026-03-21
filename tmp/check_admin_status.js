const { getAppSettings } = require('../services/database');
const fs = require('fs');
const envPath = fs.existsSync('.env.railway') ? '.env.railway' : '.env';
require('dotenv').config({ path: envPath });

async function checkSettings() {
    try {
        console.log('--- Environment Check ---');
        console.log('ADMIN_TELEGRAM_ID (ENV):', process.env.ADMIN_TELEGRAM_ID);
        console.log('BOT_TOKEN (ENV):', process.env.BOT_TOKEN ? 'Present (ending in ' + process.env.BOT_TOKEN.slice(-5) + ')' : 'Missing');
        
        console.log('\n--- Database Check ---');
        const settings = await getAppSettings();
        if (!settings) {
            console.log('FAILED to fetch settings from DB');
            return;
        }
        console.log('admin_telegram_id (DB):', settings.admin_telegram_id);
        console.log('admin_password (DB):', settings.admin_password);
        console.log('bot_token (DB - might be different):', settings.bot_token ? settings.bot_token.slice(-5) : 'Missing');
        
    } catch (e) {
        console.error('Check failed:', e);
    }
}

checkSettings();
