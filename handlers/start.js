const { Markup } = require('telegraf');
const { registerUser, getUser, incrementDailyStat, getAppSettings, addMessageToTrack, getLastMenuId, getTrackedMessages, getSupplierByTelegramId } = require('../services/database');
const { safeEdit } = require('../services/utils');
const { createPersistentMap } = require('../services/persistent_map');
const { isAdmin } = require('./admin');
const { notifyAdmins } = require('../services/notifications');
const { clearAllAwaitingMaps } = require('./supplier_marketplace');

const pendingReferralInput = createPersistentMap('pendingReferral');

async function initStartState() {
    await pendingReferralInput.load();
}

/**
 * Vérifie si l'utilisateur est abonné au canal requis
 */
async function checkSubscription(bot, ctx, settings) {
    if (ctx.platform !== 'telegram') return true;
    if (!settings.force_subscribe || !settings.force_subscribe_channel_id) return true;

    try {
        const member = await ctx.telegram.getChatMember(settings.force_subscribe_channel_id, ctx.from.id);
        const status = member.status;
        return ['creator', 'administrator', 'member'].includes(status);
    } catch (e) {
        console.error('[FORCE_SUB] Erreur checkSubscription:', e.message);
        return false; // Par défaut, on bloque si erreur (ex: bot pas admin du canal)
    }
}

/**
 * Enregistre les handlers pour la commande /start
 */
function setupStartHandler(bot) {

    bot.command('start', async (ctx) => {
        try {
            const user = ctx.from;
            const settings = ctx.state?.settings || await getAppSettings();
            const docId = `${ctx.platform}_${user.id}`;

            // Quitter tout contexte produit
            try { const { clearActiveMediaGroup } = require('../services/utils'); clearActiveMediaGroup(docId); } catch(e) {}

            // ═══ NETTOYAGE COMPLET : supprimer TOUS les messages du bot dans le chat ═══
            try {
                const chatId = ctx.chat?.id;
                const currentMsgId = ctx.message?.message_id;

                if (chatId && currentMsgId && ctx.platform === 'telegram' && ctx.telegram) {
                    // 1. D'abord supprimer tous les messages trackés en DB
                    const tracked = await getTrackedMessages(docId);
                    const trackedSet = new Set((tracked || []).map(Number));

                    // 2. Balayer les 50 derniers messages (IDs décroissants avant le /start)
                    //    Telegram permet de supprimer les messages de moins de 48h
                    const deletePromises = [];
                    for (let id = currentMsgId - 1; id >= currentMsgId - 50 && id > 0; id--) {
                        deletePromises.push(
                            ctx.telegram.deleteMessage(chatId, id).catch(() => {})
                        );
                    }
                    // Ajouter les trackés qui seraient plus anciens
                    for (const tid of trackedSet) {
                        if (tid < currentMsgId - 50) {
                            deletePromises.push(
                                ctx.telegram.deleteMessage(chatId, tid).catch(() => {})
                            );
                        }
                    }

                    // Exécuter en parallèle (les erreurs sont silencieuses)
                    await Promise.allSettled(deletePromises);

                    // 3. Vider la liste des messages trackés en DB
                    const { supabase, COL_USERS } = require('../services/database');
                    await supabase.from(COL_USERS).update({
                        tracked_messages: [],
                        last_menu_id: null
                    }).eq('id', docId);
                }
            } catch (e) {
                console.error('[START] Cleanup error:', e.message);
            }

            // Vérifier si un code de parrainage
            let referrerId = null;
            const payload = (ctx.message && ctx.message.text) ? ctx.message.text.split(' ')[1] : null;
            if (payload && payload.startsWith('ref_')) {
                referrerId = payload;
                if (payload.includes(`_${user.id}_`)) referrerId = null;
            }

            const { isNew, user: registeredUser } = await registerUser(user, ctx.platform, referrerId);
            ctx.state.user = registeredUser;
            await incrementDailyStat('start_commands');

            // --- NOUVEAU : FORCE SUBSCRIBE ---
            if (ctx.platform === 'telegram' && settings.force_subscribe) {
                const isSubscribed = await checkSubscription(bot, ctx, settings);
                if (!isSubscribed) {
                    const subText = `⚠️ <b>ABONNEMENT REQUIS</b>\n\n` +
                        `Bonjour <b>${user.first_name}</b>,\n\n` +
                        `Pour continuer et accéder à nos services, vous devez d'abord rejoindre notre canal officiel.\n\n` +
                        `C'est ici que nous publions nos nouveautés et promotions ! 🚀`;
                    
                    const subKeyboard = Markup.inlineKeyboard([
                        [Markup.button.url('📢 Rejoindre le Canal', settings.channel_url || 'https://t.me/channel')],
                        [Markup.button.callback(settings.btn_verify_sub || '✅ Vérifier / Nouveau Lien', 'check_sub')]
                    ]);

                    return await safeEdit(ctx, subText, {
                        photo: settings.welcome_photo || null,
                        ...subKeyboard
                    });
                } else if (registeredUser.is_approved === false) {
                    // Si abonné, on auto-approuve s'il était en attente
                    const { supabase, COL_USERS, ts } = require('../services/database');
                    await supabase.from(COL_USERS).update({ is_approved: true, updated_at: ts() }).eq('id', registeredUser.id);
                    registeredUser.is_approved = true;
                }
            }

            // --- NOUVEAU : SYSTÈME D'APPROBATION ---
            const isApproved = registeredUser.is_approved !== false || (await isAdmin(ctx));

            if (!isApproved) {
                // Alerte Admin avec bouton d'approbation
                const userType = registeredUser.is_livreur ? '🚚 Livreur' : '👤 Client';
                const adminMsg = `🆕 <b>DEMANDE D'ACCÈS</b>\n\n` +
                    `${userType} : <b>${user.first_name}</b>\n` +
                    `🆔 ID : <code>${user.id}</code> (Platform: ${ctx.platform})\n` +
                    `Username : @${user.username || 'Inconnu'}\n\n` +
                    `<i>Cliquez sur le bouton ci-dessous pour lui donner accès.</i>`;

                const adminKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback(`✅ ACCEPTER ${registeredUser.is_livreur ? 'LE LIVREUR' : 'LE CLIENT'}`, `approve_${ctx.platform}_${user.id}`)]
                ]);

                await notifyAdmins(bot, adminMsg, adminKeyboard).catch(() => {});

                const isWa = ctx.platform === 'whatsapp';
                const restrictedText = `🛑 <b>ACCÈS RESTREINT</b>\n\n` +
                    `Bonjour <b>${user.first_name}</b>,\n\n` +
                    `Pour accéder au bot, vous devez d'abord envoyer un message à l'administrateur.\n` +
                    `Une fois que l'admin aura validé votre accès, vous pourrez commander.\n\n` +
                    (isWa ? `📝 <i>Une fois validé, écrivez <b>/start</b> pour actualiser le menu.</i>\n\n` +
                            `👇 <b>Cliquez sur les liens ci-dessous :</b>\n` +
                            (settings.private_contact_wa_url ? `• *WhatsApp Admin :* ${settings.private_contact_wa_url}\n` : '') +
                            (settings.private_contact_url ? `• *Telegram Admin :* ${settings.private_contact_url}\n` : '') +
                            (settings.channel_url ? `• *Notre Canal :* ${settings.channel_url}\n` : '') : 
                            `👇 <b>Veuillez cliquer ci-dessous :</b>`);
                
                const b = [];
                if (settings.private_contact_url) b.push([Markup.button.url('✉️ Telegram : Admin', settings.private_contact_url)]);
                if (settings.private_contact_wa_url) b.push([Markup.button.url('✉️ WhatsApp : Admin', settings.private_contact_wa_url)]);
                b.push([Markup.button.url('📢 S’abonner au canal', settings.channel_url || 'https://t.me/channel')]);
                b.push([Markup.button.callback('🔄 Rafraîchir mon statut', 'start')]);
                
                const restrictedKeyboard = Markup.inlineKeyboard(b);

                return await safeEdit(ctx, restrictedText, {
                    photo: settings.welcome_photo || null,
                    ...restrictedKeyboard
                });
            }

            let welcomeText = '';

            // Notification Admin pour les nouveaux (déjà approuvés par chance ou anciens)
            if (isNew) {
                const newMsg = `👤 <b>NOUVEL UTILISATEUR !</b>\n\n` +
                    `Nom : ${user.first_name}\n` +
                    `Username : @${user.username || 'Inconnu'}\n` +
                    `ID : <code>${user.id}</code>\n` +
                    (referrerId ? `🎁 Parrainé par : <code>${referrerId}</code>` : `🔍 Arrivé en direct`);
                await notifyAdmins(bot, newMsg).catch(() => {});
            }

            let hasActive = false;
            if (registeredUser.is_livreur) {
                const { getLivreurOrders } = require('../services/database');
                const activeOrders = await getLivreurOrders(registeredUser.id);
                hasActive = activeOrders.length > 0;

                const city = registeredUser.current_city || registeredUser.data?.current_city || 'Non défini';
                const isAvail = registeredUser.is_available || registeredUser.data?.is_available;

                welcomeText = `${settings.ui_icon_livreur} <b>Bienvenue, ${user.first_name} !</b>\n\n` +
                    `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
                    `🔘 Statut : <b>${isAvail ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n`;

                if (hasActive) {
                    welcomeText += `🚀 <b>VOUS AVEZ ${activeOrders.length} COMMANDE(S) EN COURS !</b>\n\n` +
                        activeOrders.map(o => `📦 #${o.id.slice(-5)} - ${o.address || '?'}`).join('\n') +
                        `\n\n<i>Cliquez sur "Mes livraisons en cours" pour les gérer.</i>`;
                }
            } else {
                const paymentLine = settings.payment_modes
                    ? `\n🚨 <b>Le paiement s'effectue en : ${settings.payment_modes}</b>‼️\n`
                    : '';
                if (isNew) {
                    welcomeText = `✨ <b>Bienvenue sur ${settings.bot_name}, ${user.first_name} !</b>\n\n` +
                        `${settings.welcome_message || ''}\n${paymentLine}\n` +
                        `📍 <i>En utilisant ce service, vous acceptez d'être localisé tacitement.</i>\n\n` +
                        `🔗 <b>Votre lien de parrainage :</b>\n` +
                        `<code>https://t.me/${ctx.botInfo?.username || 'bot'}?start=${registeredUser.referral_code}</code>`;
                    if (!referrerId) pendingReferralInput.set(docId, true);
                } else {
                    const defaultBack = `👋 <b>Ravi de vous revoir, ${user.first_name} !</b>\n\nVous êtes déjà membre du ${settings.bot_name}.${paymentLine}`;
                    welcomeText = settings.msg_welcome_back 
                        ? settings.msg_welcome_back.replace('{first_name}', user.first_name).replace('{bot_name}', settings.bot_name).replace('{payment_line}', paymentLine)
                        : defaultBack;
                }
            }
            
            const supplier = await getSupplierByTelegramId(String(ctx.from.id));
            const isFournisseur = !!supplier;

            const keyboard = registeredUser.is_livreur ? await getLivreurMenuKeyboard(ctx, settings, registeredUser, hasActive) : await getMainMenuKeyboard(ctx, settings, registeredUser, isFournisseur);
            await safeEdit(ctx, welcomeText, {
                photo: settings.welcome_photo || null,
                ...keyboard
            });

            if (ctx.telegram) {
                ctx.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' }).catch(() => { });
            }

        } catch (error) {
            console.error('❌ Erreur /start:', error);
        }
    });

    bot.action('check_sub', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        if (ctx.platform === 'telegram' && settings.force_subscribe) {
            const isSubscribed = await checkSubscription(bot, ctx, settings);
            if (!isSubscribed) {
                return ctx.reply('❌ Vous n\'êtes pas encore abonné au canal. Veuillez cliquer sur "Rejoindre le Canal" puis réessayer.', { parse_mode: 'HTML' });
            } else {
                ctx.reply('✅ Abonnement vérifié avec succès !', { parse_mode: 'HTML' });
                // Simulate a /start command to re-evaluate the user logic
                return bot.handleUpdate({ ...ctx.update, message: { text: '/start', from: ctx.from } });
            }
        }
        return bot.handleUpdate({ ...ctx.update, message: { text: '/start', from: ctx.from } });
    });

    bot.action('main_menu', async (ctx) => {
        if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
        // Nettoyer les états marketplace pour éviter l'interception des messages
        clearAllAwaitingMaps(ctx.from.id);
        const settings = await getAppSettings();
        const user = await getUser(`${ctx.platform}_${ctx.from.id}`);
        
        // Anti-blocage unapproved en retour menu
        const isApproved = user?.is_approved !== false || (await isAdmin(ctx));
        if (!isApproved) {
            return bot.handleUpdate({ ...ctx.update, message: { text: '/start', from: ctx.from } });
        }

        const text = `📋 <b>Menu principal</b>`;
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        const isFournisseur = !!supplier;
        let keyboard = await getMainMenuKeyboard(ctx, settings, user, isFournisseur);

        if (user && user.is_livreur) {
            const { getLivreurOrders } = require('../services/database');
            const activeOrders = await getLivreurOrders(user.id);
            const hasActive = activeOrders.length > 0;
            const city = user?.current_city || user?.data?.current_city || 'Non défini';
            const isAvail = user?.is_available || user?.data?.is_available;

            const livreurText = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
                `👤 ${user.first_name || ctx.from.first_name}\n` +
                `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
                `🔘 Statut : <b>${isAvail ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n`;

            keyboard = await getLivreurMenuKeyboard(ctx, settings, user, hasActive);
            return await safeEdit(ctx, livreurText, { photo: settings.welcome_photo || null, ...keyboard });
        }

        await safeEdit(ctx, text, {
            photo: settings.welcome_photo || null,
            ...keyboard
        });
    });

    bot.action('client_mode_force', async (ctx) => {
        if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
        const settings = await getAppSettings();
        const user = await getUser(`${ctx.platform}_${ctx.from.id}`);
        const supplier = await getSupplierByTelegramId(String(ctx.from.id));
        const isFournisseur = !!supplier;
        
        const text = `🛒 <b>Mode Client</b>\n\nVous pouvez maintenant commander comme un client normal.`;
        const keyboard = await getMainMenuKeyboard(ctx, settings, user, isFournisseur);
        
        await safeEdit(ctx, text, {
            photo: settings.welcome_photo || null,
            ...keyboard
        });
    });

    bot.action('private_contact', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const buttons = [];
        if (settings.private_contact_url) {
            buttons.push([Markup.button.url('📲 Telegram : Admin', settings.private_contact_url)]);
        }
        if (settings.private_contact_wa_url) {
            buttons.push([Markup.button.url('📲 WhatsApp : Admin', settings.private_contact_wa_url)]);
        }
        buttons.push([Markup.button.callback('◀️ Retour', 'main_menu')]);
        
        let text = `${settings.ui_icon_contact || '💬'} <b>${settings.label_contact || 'Contact Admin'}</b>\n\n` +
                   (settings.private_contact_url ? `🔹 Telegram : <a href="${settings.private_contact_url}">${settings.private_contact_url}</a>\n` : '') +
                   (settings.private_contact_wa_url ? `🔸 WhatsApp : <a href="${settings.private_contact_wa_url}">${settings.private_contact_wa_url}</a>\n\n` : '\n') +
                   `Cliquez sur l'un des boutons ci-dessous pour nous envoyer un message privé.`;
        await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    });

    bot.action('channel_link', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state?.settings || await getAppSettings();
        const buttons = [
            [Markup.button.url('📢 Rejoindre le canal', settings.channel_url || 'https://t.me/channel'), Markup.button.callback('◀️ Retour', 'main_menu')]
        ];
        let text = `${settings.ui_icon_channel} <b>${settings.label_channel || 'Lien Canal'}</b>\n\n` +
                   (settings.channel_url ? `📢 Lien direct : <a href="${settings.channel_url}">${settings.channel_url}</a>\n\n` : '') +
                   `Restez informé de nos nouveautés en rejoignant notre canal officiel.`;
        await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    });

    bot.on('location', async (ctx) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const loc = ctx.message.location;
        if (!loc) return;
        try {
            const { saveUserLocation } = require('../services/database');
            await saveUserLocation(userId, loc.latitude, loc.longitude);
            await ctx.reply('✅ Position enregistrée.');
        } catch (e) { console.error('Location error:', e); }
    });

    bot.on('text', async (ctx, next) => {
        const docId = `${ctx.platform}_${ctx.from.id}`;
        const inputText = ctx.message.text.trim();
        if (!pendingReferralInput.has(docId)) return next();
        pendingReferralInput.delete(docId);
        if (inputText.startsWith('ref_') || (inputText.startsWith('/start ') && inputText.includes('ref_'))) {
            const ref = inputText.startsWith('/start ') ? inputText.split(' ')[1] : inputText;
            try {
                const { registerUser } = require('../services/database');
                await registerUser(ctx.from, ctx.platform, ref);
                return ctx.reply('🎉 Code parrainage validé !');
            } catch (e) { }
        }
        return next();
    });

    bot.action('check_sub', async (ctx) => {
        const settings = await getAppSettings();
        const isSubscribed = await checkSubscription(bot, ctx, settings);
        
        if (!isSubscribed) {
            return await ctx.answerCbQuery('❌ Vous n\'êtes pas encore abonné au canal !', { show_alert: true });
        }
        
        await ctx.answerCbQuery('✅ Merci pour votre abonnement !');
        // Relancer le start
        return bot.handleUpdate({ ...ctx.update, message: { text: '/start', from: ctx.from } });
    });
}

async function getMainMenuKeyboard(ctx, settings, user, isFournisseur = false) {
    if (!settings) settings = ctx.state?.settings || await getAppSettings();
    const buttons = [];

    // Ligne 1 : Commander (Gros bouton principal)
    buttons.push([Markup.button.callback(`${settings.ui_icon_catalog || '👟'} ${settings.label_catalog || 'Passer une commande'}`, 'view_catalog')]);
    
    // Suivi commande (Uniquement si panier plein)
    const { userCarts } = require('./order_system');
    const cart = userCarts.get(`${ctx.platform}_${ctx.from.id}`) || [];
    if (cart.length > 0) {
        buttons.push([Markup.button.callback(`🛒 REPRENDRE MON PANIER (${cart.length})`, 'view_cart')]);
    }

    // Ligne 2 : Panier & Mes Commandes
    buttons.push([
        Markup.button.callback(`${settings.ui_icon_cart || '🛒'} Panier`, 'view_cart'),
        Markup.button.callback(`${settings.ui_icon_orders || '📦'} Commandes`, 'my_orders')
    ]);

    // Ligne 3 : Aide & Contact
    const row3 = [];
    if (settings.enable_help_menu !== false) {
        row3.push(Markup.button.callback(`${settings.ui_icon_support || '❓'} Aide`, 'help_menu'));
    }
    row3.push(Markup.button.callback(`${settings.ui_icon_contact || '📱'} Contact`, 'private_contact'));
    if (row3.length > 0) buttons.push(row3);

    // Ligne 4 : Parrainage & Canal
    const row4 = [];
    if (settings.enable_referral !== false) {
        row4.push(Markup.button.callback(`${settings.ui_icon_profile || '🎁'} Parrain`, 'my_referrals'));
    }
    row4.push(Markup.button.callback(`${settings.ui_icon_channel || '📢'} Canal`, 'channel_link'));
    if (row4.length > 0) buttons.push(row4);

    // Ligne 5 : Espace Livreur / Fournisseur
    const spaces = [];
    if (user?.is_livreur) spaces.push(Markup.button.callback(`${settings.ui_icon_livreur || '🚴'} Livreur`, 'livreur_menu'));
    if (settings.enable_marketplace !== false) {
        if (user?.is_supplier || user?.is_mp_admin || isFournisseur) {
            spaces.push(Markup.button.callback('🏪 Fourn.', 'supplier_menu'));
        }
    }
    if (spaces.length > 0) buttons.push(spaces);

    // Ligne de fin : Paramètres & Admin
    const footers = [Markup.button.callback(`${settings.btn_settings || '⚙️'} Réglages`, 'user_settings')];
    if (user?.is_admin || (await isAdmin(ctx))) {
        footers.push(Markup.button.callback(`${settings.ui_icon_admin || '🛠'} Admin`, 'admin_menu'));
    }
    buttons.push(footers);

    return Markup.inlineKeyboard(buttons);
}

async function getLivreurMenuKeyboard(ctx, settings, user, hasActiveOrders = false) {
    const isAvail = user?.is_available || user?.data?.is_available;
    const buttons = [
        [Markup.button.callback(isAvail ? '🔴 Indisponible' : '🟢 Disponible', isAvail ? 'set_dispo_false' : 'set_dispo_true')],
        [Markup.button.callback(`${settings.ui_icon_orders || '📦'} Commandes`, 'show_available_orders'), Markup.button.callback('🗓 Planifiées', 'show_planned_orders')],
        [Markup.button.callback(`${settings.ui_icon_stats || '📈'} Historique`, 'my_deliveries'), Markup.button.callback(settings.btn_client_mode || '🛍 Client', 'client_mode_force')]
    ];
    if (hasActiveOrders) buttons.unshift([Markup.button.callback('🚚 MES LIVRAISONS EN COURS 🔥', 'active_deliveries')]);
    if (user?.is_admin || (await isAdmin(ctx))) buttons.push([Markup.button.callback('🛠 Admin Panel', 'admin_menu')]);
    
    return Markup.inlineKeyboard(buttons);
}

module.exports = { setupStartHandler, initStartState, getLivreurMenuKeyboard, getMainMenuKeyboard };
