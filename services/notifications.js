const { getAppSettings } = require('./database');
const { registry } = require('../channels/ChannelRegistry');

/**
 * Récupère l'instance du bot Telegram depuis le registre des canaux.
 */
function getTgBot() {
    const tg = registry.query('telegram');
    if (!tg) {
        console.warn('[getTgBot] registry.query("telegram") returned null');
        return null;
    }
    if (!tg.getBotInstance) {
        console.warn('[getTgBot] Channel has no getBotInstance method');
        return null;
    }
    const bot = tg.getBotInstance();
    if (!bot || !bot.telegram) {
        console.warn(`[getTgBot] getBotInstance() returned ${bot ? 'bot without .telegram' : 'null'}`);
    }
    return bot;
}

async function notifyAdmins(bot, message, options = {}) {
    console.log('[notifyAdmins] Appel reçu');
    try {
        if (typeof bot === 'string') {
            options = message || {};
            message = bot;
            bot = null;
        }

        const settings = await getAppSettings();
        if (!settings) {
            console.error('[notifyAdmins] Impossible de charger les settings');
            return;
        }

        const rawAdmins = String(settings.admin_telegram_id || '');
        console.log('[notifyAdmins] rawAdmins de DB:', rawAdmins);

        const dbAdmins = rawAdmins.replace(/[\[\]"']/g, '').split(/[\s,]+/).filter(Boolean);
        const envAdmin = process.env.ADMIN_TELEGRAM_ID;
        const allAdmins = [...new Set([...dbAdmins, envAdmin].filter(Boolean))];

        console.log(`[notifyAdmins] Liste finale des admins à notifier:`, allAdmins);

        if (allAdmins.length === 0) {
            console.warn("[notifyAdmins] LISTE VIDE (Admin alert ignorée)");
            return;
        }

        const sendPromises = allAdmins.map(async (adminId) => {
            const idStr = String(adminId);
            const finalId = (idStr.includes('_') || idStr.includes('@')) ? idStr : `telegram_${idStr}`;
            console.log(`[notifyAdmins] Envoi à ${finalId}...`);
            try {
                const res = await sendMessageToUser(finalId, message, options, bot);
                if (!res) console.error(`[notifyAdmins] Résultat NULL pour ${finalId}`);
                else console.log(`[notifyAdmins] ✅ Message envoyé à ${finalId}`);
                return res;
            } catch (err) {
                console.error(`[notifyAdmins] ❌ Échec pour ${finalId}:`, err.message);
                return null;
            }
        });
        await Promise.allSettled(sendPromises);

    } catch (e) {
        console.error("❌ notifyAdmins FATAL:", e.message);
    }
}

async function notifyLivreurs(bot, message, options = {}) {
    console.log('[notifyLivreurs] Appel reçu');
    try {
        const { getAllLivreurs } = require('./database');
        const allLivreurs = await getAllLivreurs();
        console.log(`[notifyLivreurs] Nombre de livreurs trouvés en DB: ${allLivreurs ? allLivreurs.length : 0}`);

        if (!allLivreurs || allLivreurs.length === 0) return;

        const sendPromises = allLivreurs.map(async (livreur) => {
            const userId = livreur.id || (livreur.telegram_id ? `telegram_${livreur.telegram_id}` : null);
            if (!userId) return null;
            console.log(`[notifyLivreurs] Envoi à ${userId}...`);
            try {
                return await sendMessageToUser(userId, message, options, bot);
            } catch (err) {
                console.error(`[notifyLivreurs] ❌ Échec pour ${userId}:`, err.message);
                return null;
            }
        });
        await Promise.allSettled(sendPromises);
    } catch (e) {
        console.error("❌ notifyLivreurs FATAL:", e.message);
    }
}

/**
 * Envoie un message à un utilisateur, détectant automatiquement s'il est sur Telegram ou WhatsApp.
 */
async function sendMessageToUser(userId, message, options = {}, providedBot = null) {
    const idStr = String(userId);
    const platform = idStr.startsWith('whatsapp') || idStr.includes('@') ? 'whatsapp' : 'telegram';
    const cleanId = idStr.replace(/^(telegram_|whatsapp_)/, '');

    console.log(`[MSG-Gen] Target=${userId} Plateforme=${platform} CleanID=${cleanId}`);

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

        // Telegram branch — essayer providedBot, puis le registre, puis fallback
        let realBot = (providedBot && providedBot.telegram) ? providedBot : getTgBot();
        if (!realBot || !realBot.telegram) {
            console.log(`[Notification] getTgBot() = ${realBot ? 'has bot but no .telegram' : 'null'}, trying server fallback...`);
            try {
                const { getBotInstance } = require('../server');
                realBot = getBotInstance();
                console.log(`[Notification] server.getBotInstance() = ${realBot ? (realBot.telegram ? 'OK' : 'has bot but no .telegram') : 'null'}`);
            } catch (e) {
                console.error(`[Notification] server fallback failed: ${e.message}`);
            }
        }
        if (!realBot || !realBot.telegram) {
            console.error(`[Notification] Bot Telegram inactif, impossible d'envoyer à ${userId}`);
            return null;
        }
        
        const sent = await realBot.telegram.sendMessage(cleanId, message, {
            parse_mode: 'HTML',
            ...options
        });
        // Tracker ce message intermédiaire pour cleanup quand l'user revient au menu
        if (sent && sent.message_id) {
            try {
                const { trackIntermediateMessage } = require('./utils');
                trackIntermediateMessage(idStr, sent.message_id);
            } catch (e) { }
            const { addMessageToTrack } = require('./database');
            addMessageToTrack(idStr, sent.message_id, false).catch(() => {});
        }
        return sent;
    } catch (e) {
        console.error(`❌ sendMessageToUser to ${idStr} failed:`, e.message);
        return null;
    }
}

async function sendTelegramMessage(userId, message, options = {}) {
    return sendMessageToUser(userId, message, options);
}

module.exports = { notifyAdmins, notifyLivreurs, sendTelegramMessage, sendMessageToUser };
