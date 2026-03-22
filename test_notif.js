const { notifyAdmins } = require('./services/notifications');
const { initChannels } = require('./services/channel_init');
const { registry } = require('./channels/ChannelRegistry');
const { setBotInstance } = require('./server');

async function test() {
    console.log('--- TEST NOTIFICATION ADMIN ---');
    await initChannels();
    const tg = registry.query('telegram');
    const bot = tg.getBotInstance();
    setBotInstance(bot);
    
    console.log('Envoi d\'un test à l\'admin...');
    const res = await notifyAdmins(bot, "🔔 <b>TEST NOTIFICATION</b>\n\nSi vous recevez ce message, les notifications admin fonctionnent !");
    console.log('Résultat:', JSON.stringify(res, null, 2));
    
    process.exit(0);
}

test().catch(e => {
    console.error('Test Failed:', e);
    process.exit(1);
});
