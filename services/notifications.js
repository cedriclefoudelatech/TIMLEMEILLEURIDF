const { getAppSettings } = require('./database');
const { registry } = require('../channels/ChannelRegistry');

/**
 * Récupère l'instance du bot Telegram depuis le registre des canaux.
 */
function getTgBot() {
    const tg = registry.query('telegram');
    return tg ? tg.getBotInstance() : null;
}

async function notifyAdmins(bot, message) {
    try {
        // Si bot est null ou ne semble pas être un objet Telegraf, on cherche l'instance globale
        const realBot = (bot && bot.telegram) ? bot : getTgBot();
        
        if (!realBot || !realBot.telegram) {
            console.error("❌ notifyAdmins: No Telegram bot found in registry or arguments");
            return;
        }

        // On supporte l'appel avec (message) seul si bot est omis
        if (typeof bot === 'string' && !message) {
            message = bot;
        }

        const settings = await getAppSettings();
        if (!settings || !settings.admin_telegram_id) return;

        const rawAdmins = String(settings.admin_telegram_id || '');
        const dbAdmins = rawAdmins.replace(/[\[\]"']/g, '').split(/[\s,]+/).filter(Boolean);
        const envAdmin = process.env.ADMIN_TELEGRAM_ID;
        const allAdmins = [...new Set([...dbAdmins, envAdmin].filter(Boolean))];

        for (const adminId of allAdmins) {
            // Unify ID format if it's just a number, assume telegram
            const finalId = (adminId.includes('_') || adminId.includes('@')) ? adminId : `telegram_${adminId}`;
            console.log(`[Notification] Envoi alerte admin à ${finalId}: ${message.substring(0, 50)}...`);
            await sendMessageToUser(finalId, message).catch((err) => { 
                console.error(`[Notification] Échec envoi à ${finalId}:`, err.message);
            });
        }
        if (allAdmins.length === 0) {
            console.warn("[Notification] Aucun admin trouvé pour envoyer l'alerte.");
        }
    } catch (e) {
        console.error("❌ notifyAdmins failed:", e.message);
    }
}

async function notifyLivreurs(bot, message, options = {}) {
    try {
        const { getAllLivreurs } = require('./database');
        const allLivreurs = await getAllLivreurs();
        
        for (const l of allLivreurs) {
            if (l.is_livreur && l.is_available) {
                await sendMessageToUser(l.id, message, options).catch(() => { });
            }
        }
    } catch (e) {
        console.error("❌ notifyLivreurs failed:", e.message);
    }
}

/**
 * Envoie un message à un utilisateur, détectant automatiquement s'il est sur Telegram ou WhatsApp.
 */
async function sendMessageToUser(userId, message, options = {}) {
    const idStr = String(userId);
    const platform = idStr.startsWith('whatsapp') || idStr.includes('@') ? 'whatsapp' : 'telegram';
    const cleanId = idStr.replace(/^(telegram_|whatsapp_)/, '');

    try {
        if (platform === 'whatsapp') {
            const wa = registry.query('whatsapp');
            if (wa && wa.isActive) {
                let waButtons = [];
                if (options.reply_markup && options.reply_markup.inline_keyboard) {
                    waButtons = options.reply_markup.inline_keyboard.flat().map(b => ({
                        id: b.callback_data,
                        title: b.text,
                        url: b.url
                    }));
                }
                if (waButtons.length > 0) {
                    return await wa.sendInteractive(cleanId, message, waButtons, options);
                } else {
                    return await wa.sendMessage(cleanId, message, options);
                }
            } else {
                console.warn(`[Notification] WhatsApp inactif, impossible d'envoyer à ${userId}`);
                return null;
            }
        }

        // Telegram branch
        const realBot = getTgBot();
        if (!realBot || !realBot.telegram) {
            console.error(`[Notification] Bot Telegram inactif, impossible d'envoyer à ${userId}`);
            return null;
        }
        
        return await realBot.telegram.sendMessage(cleanId, message, {
            parse_mode: 'HTML',
            ...options
        });
    } catch (e) {
        console.error(`❌ sendMessageToUser to ${idStr} failed:`, e.message);
        return null;
    }
}

async function sendTelegramMessage(userId, message, options = {}) {
    return sendMessageToUser(userId, message, options);
}

module.exports = { notifyAdmins, notifyLivreurs, sendTelegramMessage, sendMessageToUser };
