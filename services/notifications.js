const { getAppSettings } = require('./database');
const { registry } = require('../channels/ChannelRegistry');

// Résolution ultra-robuste de l'instance du bot Telegram
function getBotForNotification(providedBot = null) {
    if (providedBot && providedBot.telegram) return providedBot;

    // 1. Chercher dans le registre
    const tgChannel = registry.query('telegram');
    if (tgChannel && typeof tgChannel.getBotInstance === 'function') {
        const bot = tgChannel.getBotInstance();
        if (bot && bot.telegram) return bot;
    }

    // 2. Fallback via le singleton partagé
    try {
        const { getBotInstance } = require('../server');
        const fallback = getBotInstance();
        if (fallback && fallback.telegram) return fallback;
    } catch (e) {}

    return null;
}

/**
 * Notifier les administrateurs
 */
async function notifyAdmins(bot, message, options = {}) {
    console.log('[Notification-Admin] Appel reçu pour alerte admin');
    try {
        if (typeof bot === 'string') {
            options = message || {};
            message = bot;
            bot = null;
        }

        const settings = await getAppSettings();
        if (!settings) {
            console.error('[Notification-Admin] Impossible de charger les paramètres DB');
            return;
        }

        // --- Parsing des IDs Administrateurs ---
        let admins = [];
        const dbRaw = settings.admin_telegram_id;
        console.log('[Notification-Admin] rawAdmins en base:', typeof dbRaw, dbRaw);

        if (Array.isArray(dbRaw)) {
            admins = dbRaw.map(String);
        } else if (typeof dbRaw === 'string') {
            admins = dbRaw.replace(/[\[\]"']/g, '').split(/[\s,]+/).filter(Boolean);
        } else if (dbRaw && typeof dbRaw === 'object') {
             admins = Object.values(dbRaw).map(String);
        } else if (dbRaw) {
            admins = [String(dbRaw)];
        }

        const envAdmin = process.env.ADMIN_TELEGRAM_ID;
        const allAdmins = [...new Set([...admins, envAdmin].filter(Boolean))];

        if (allAdmins.length === 0) {
            console.warn('[Notification-Admin] AUCUN admin trouvé (Base + ENV vides)');
            return;
        }

        console.log(`[Notification-Admin] 🚀 Liaison vers ${allAdmins.length} admins: ${allAdmins.join(', ')}`);

        const sendPromises = allAdmins.map(async (adminId) => {
            const idStr = String(adminId).trim();
            if (!idStr) return null;
            const finalId = (idStr.includes('_') || idStr.includes('@')) ? idStr : `telegram_${idStr}`;
            try {
                const res = await sendMessageToUser(finalId, message, options, bot);
                if (res) console.log(`[Notification-Admin] ✅ Envoyé à ${finalId}`);
                else console.warn(`[Notification-Admin] ⚠️ Échec (résultat null) pour ${finalId}`);
                return res;
            } catch (err) {
                console.error(`[Notification-Admin] ❌ Crash pour ${finalId}:`, err.message);
                return null;
            }
        });
        return await Promise.allSettled(sendPromises);
    } catch (e) {
        console.error("❌ notifyAdmins CRITICAL:", e.message);
    }
}

/**
 * Notifier les livreurs
 */
async function notifyLivreurs(bot, message, options = {}) {
    try {
        const { getAllLivreurs } = require('./database');
        const allLivreurs = await getAllLivreurs();
        if (!allLivreurs || allLivreurs.length === 0) {
            console.log(`[Notification-Livreurs] Aucun livreur disponible`);
            return;
        }

        console.log(`[Notification-Livreurs] 🚀 Diffusion vers ${allLivreurs.length} livreurs...`);

        const sendPromises = allLivreurs.map(async (livreur) => {
            const userId = livreur.id || (livreur.telegram_id ? `telegram_${livreur.telegram_id}` : null);
            if (!userId) return null;
            try {
                return await sendMessageToUser(userId, message, options, bot);
            } catch (err) {
                console.error(`[Notification-Livreurs] ❌ Échec pour ${userId}:`, err.message);
                return null;
            }
        });
        return await Promise.allSettled(sendPromises);
    } catch (e) {
        console.error("❌ notifyLivreurs FATAL:", e.message);
    }
}

async function notifySuppliers(bot, cart, orderId, address, settings = null) {
    try {
        const { getSupplier, markOrderSupplierNotified, getProducts } = require('./database');
        const { esc } = require('./utils');

        if (!settings) settings = await getAppSettings();
        const cartItems = Array.isArray(cart) ? cart : [cart];
        const allProducts = await getProducts();

        for (const item of cartItems) {
            const sid = item.supplier_id || item.product?.supplier_id;
            if (sid) {
                const supplier = await getSupplier(sid);
                if (supplier && supplier.telegram_id) {
                    const product = allProducts.find(p => String(p.id) === String(item.productId || item.id || item.product_id));
                    const prodName = product ? product.name : (item.productName || 'Produit');

                    const supplierMsg = (settings.msg_supplier_new_order || "📦 <b>Nouvelle commande !</b>") +
                        `\n\n📦 Produit : ${esc(prodName)} x${item.qty || 1}\n` +
                        `📍 Adresse : ${esc(address)}\n` +
                        `🔑 Commande : #${orderId.slice(-5)}`;

                    sendMessageToUser(`telegram_${supplier.telegram_id}`, supplierMsg, {}, bot)
                        .then(() => markOrderSupplierNotified(orderId))
                        .catch(() => {});
                }
            }
        }
    } catch (e) {
        console.error("❌ notifySuppliers FATAL:", e.message);
    }
}

/**
 * Noyau d'envoi de message universel
 */
async function sendMessageToUser(userId, message, options = {}, providedBot = null) {
    const idStr = String(userId);
    const platform = (idStr.startsWith('whatsapp_') || idStr.includes('@')) ? 'whatsapp' : 'telegram';
    const cleanId = idStr.replace(/^(telegram_|whatsapp_)/, '');

    try {
        if (platform === 'whatsapp') {
            const wa = registry.query('whatsapp');
            if (!wa || !wa.isActive) return null;

            let waButtons = [];
            const srcKeyboard = options.inline_keyboard || options.keyboard || options.reply_markup?.inline_keyboard;
            if (srcKeyboard) {
                waButtons = srcKeyboard.flat().map(b => ({
                    id: b.callback_data,
                    title: b.text,
                    url: b.url
                })).filter(b => b.id || b.url);
            }

            if (waButtons.length > 0) {
                return await wa.sendInteractive(cleanId, message, waButtons, options);
            }
            return await wa.sendMessage(cleanId, message, options);
        }

        // --- Telegram ---
        let realBot = getBotForNotification(providedBot);
        if (!realBot || !realBot.telegram) {
            console.error(`[MSG-Gen] BOT INTROUVABLE pour notifier Telegram ${cleanId}`);
            return null;
        }

        // Normalisation ultra-robuste des options
        const extra = { parse_mode: 'HTML' };

        // Gestion récursive du reply_markup
        if (options.reply_markup) {
             extra.reply_markup = options.reply_markup;
        } else if (options.inline_keyboard || options.keyboard) {
             extra.reply_markup = options;
        }

        // Si options contient lui-même parse_mode ou d'autres trucs
        if (options.parse_mode) extra.parse_mode = options.parse_mode;
        if (options.protect_content !== undefined) extra.protect_content = options.protect_content;

        const sent = await realBot.telegram.sendMessage(cleanId, message, extra);
        if (sent && sent.message_id) {
            try {
                const { trackIntermediateMessage } = require('./utils');
                trackIntermediateMessage(userId, sent.message_id);
            } catch (e) {}

            try {
                const { addMessageToTrack } = require('./database');
                addMessageToTrack(userId, sent.message_id, false).catch(() => {});
            } catch (e) {}
        }
        return sent;
    } catch (e) {
        console.error(`[MSG-ERR] ${userId}:`, e.message);
        return null;
    }
}

async function sendTelegramMessage(userId, message, options = {}) {
    return sendMessageToUser(userId, message, options);
}

module.exports = { notifyAdmins, notifyLivreurs, notifySuppliers, sendTelegramMessage, sendMessageToUser };
