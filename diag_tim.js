const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
require('dotenv').config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;
const botToken = process.env.BOT_TOKEN;
const envAdmin = process.env.ADMIN_TELEGRAM_ID;

console.log('--- DIAGNOSTIC TIM ---');
console.log('URL:', url);
console.log('ENV ADMIN:', envAdmin);
console.log('BOT TOKEN:', botToken ? botToken.substring(0, 10) + '...' : 'MISSING');

async function run() {
    try {
        const supabase = createClient(url, key);
        const { data, error } = await supabase.from('bot_settings').select('*').single();
        if (error) {
            console.error('❌ Error fetching settings:', error.message);
        } else {
            console.log('✅ DB Settings fetched successfully.');
            console.log('DB ADMIN ID:', data.admin_telegram_id);
            console.log('BOT NAME:', data.bot_name);
            console.log('PRIVATE CONTACT URL:', data.private_contact_url);
        }

        if (botToken) {
            const axios = require('axios');
            try {
                const res = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`);
                console.log('✅ Bot GetMe:', res.data.result.username);
            } catch (e) {
                console.error('❌ Bot Token Error:', e.message);
            }
        }
    } catch (e) {
        console.error('❌ Critical Error:', e.message);
    }
}

run();
