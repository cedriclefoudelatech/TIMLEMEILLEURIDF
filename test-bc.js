const { broadcastMessage } = require('./services/broadcast');
const { ChannelRegistry, registry } = require('./channels/ChannelRegistry');
const { TelegramChannel } = require('./channels/TelegramChannel');
require('dotenv').config();

async function run() {
    const tgChannel = new TelegramChannel(process.env.BOT_TOKEN);
    await tgChannel.initialize();
    registry.register(tgChannel);
    tgChannel.isActive = true;

    try {
        const r = await broadcastMessage('telegram', 'Test broadcast final');
        console.log(r);
    } catch(e) {
        console.error(e);
    }
}
run();
