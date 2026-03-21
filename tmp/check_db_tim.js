const { getAppSettings } = require('../services/database');

async function check() {
    console.log('--- DB Check for TIM ---');
    const settings = await getAppSettings();
    console.log('Admin IDs:', settings.admin_telegram_id);
}
check();
