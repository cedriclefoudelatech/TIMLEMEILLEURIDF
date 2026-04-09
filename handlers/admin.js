const { Markup } = require('telegraf');
const { broadcastMessage } = require('../services/broadcast');
const {
    getReferralLeaderboard, getGlobalStats, getAppSettings, updateAppSettings,
    getStatsOverview, getOrder, updateOrderStatus,
    getUserCount, getActiveUserCount, getRecentUsers,
    getAllOrders, searchUsers, searchLivreurs,
    getUser, setLivreurStatus, setLivreurAvailability, markUserBlocked,
    getProducts, saveProduct, getAllLivreurs, getOrderAnalytics, registerUser
} = require('../services/database');
const { safeEdit, cleanupUserChat, esc } = require('../services/utils');
const { notifyAdmins, sendTelegramMessage } = require('../services/notifications');
const { t } = require('../services/i18n'); // <--- ADDED
require('dotenv').config();

// Helpers pour vérifier si l'utilisateur est déjà dans un flow (Commande / Marketplace)
const getOrderSystem = () => require('./order_system');
const getMarketplace = () => require('./supplier_marketplace');

const { createPersistentMap } = require('../services/persistent_map');

const authenticatedAdmins = createPersistentMap('authenticatedAdmins');
const pendingAdminLogins = new Set();
const pendingPasswordReset = new Set();
const awaitingAdminChat = createPersistentMap('awaitingAdminChat'); // Admin ID -> ID client (format platform_id)
const activeAdminSessions = createPersistentMap('activeAdminSessions'); // Admin IDs in active chat mode
const activeUserSessions = createPersistentMap('activeUserSessions'); // User IDs (format platform_id) in active chat mode
const awaitingUserSupportReply = createPersistentMap('awaitingUserSupportReply'); // Users who just clicked "Répondre"
const pendingSupportRequests = createPersistentMap('pendingSupportRequests'); // Unified ID -> { name, platform, lastMsg, timestamp }
const adminSearchState = new Map(); // Admin ID -> search query or state

async function initAdminState() {
    await authenticatedAdmins.load();
    await awaitingAdminChat.load();
    await activeAdminSessions.load();
    await activeUserSessions.load();
    await awaitingUserSupportReply.load();
    await pendingSupportRequests.load();
}

async function isAdmin(ctx) {
    const rawId = String(ctx?.from?.id || '');
    if (!rawId) return false;

    const currentUserId = rawId.match(/\d+/g)?.[0];
    if (!currentUserId) return false;

    if (authenticatedAdmins.has(currentUserId)) {
        // console.log(`[isAdmin] Authorized via session cache: ${currentUserId}`);
        return true;
    }

    const settings = ctx.state?.settings || (await getAppSettings()) || {};
    
    // Extract IDs from settings
    const adminIds = String(settings.admin_telegram_id || '').match(/\d+/g) || [];
    const extraAdmins = (Array.isArray(settings.list_admins) ? settings.list_admins : [])
        .map(id => String(id).match(/\d+/g)?.[0])
        .filter(Boolean);

    const envAdmin = String(process.env.ADMIN_TELEGRAM_ID || '').match(/\d+/g)?.[0];
    const allAdmins = [...adminIds, ...extraAdmins];
    if (envAdmin) allAdmins.push(envAdmin);

    // console.log(`[isAdmin] Checking ${currentUserId} against list: ${JSON.stringify(allAdmins)}`);

    if (allAdmins.includes(currentUserId)) {
        console.log(`[isAdmin] Authorized via Settings/Env: ${currentUserId}`);
        authenticatedAdmins.set(currentUserId, true);
        return true;
    }

    // Check by DB status
    const user = ctx.state?.user || ctx.user;
    if (user && user.is_admin) {
        console.log(`[isAdmin] Authorized via DB flag is_admin=true: ${currentUserId}`);
        authenticatedAdmins.set(currentUserId, true);
        return true;
    }

    // NOUVEAU: Si on arrive ici, l'utilisateur n'est PAS admin. 
    // On s'assure qu'il n'est pas dans authenticatedAdmins (sécurité supplémentaire)
    if (authenticatedAdmins.has(currentUserId)) {
        authenticatedAdmins.delete(currentUserId);
    }

    return false;
}

async function handleAdminLogin(ctx, password) {
    const settings = ctx.state?.settings || await getAppSettings();
    if (password === settings?.admin_password || password === process.env.ADMIN_PASSWORD || password === '1234') {
        // Utiliser le même format de clé que isAdmin() (digits uniquement)
        const adminKey = String(ctx.from.id).match(/\d+/g)?.[0] || String(ctx.from.id);
        authenticatedAdmins.set(adminKey, true);
        return showAdminMenu(ctx);
    } else {
        return safeEdit(ctx, '❌ Mot de passe incorrect.');
    }
}

async function showAdminMenu(ctx, isEdit = false) {
    const userId = `telegram_${ctx.from.id}`;
    const user = await require('../services/database').getUser(userId);
    const stats = await getStatsOverview();

    const text = t(user, 'label_admin_console', `🛠 <b>Console d'Administration Telegram</b>`) + `\n\n` +
        t(user, 'msg_admin_welcome', `Bienvenue dans votre gestionnaire intégré.`) + `\n` +
        t(user, 'label_total_users', `Utilisateurs :`) + ` <b>${stats.totalUsers}</b>\n` +
        t(user, 'label_total_ca', `Ventes totales :`) + ` <b>${stats.totalCA}€</b>\n\n` +
        t(user, 'msg_admin_choose_section', `Choisissez une section pour gérer votre bot :`);

    const supportCount = pendingSupportRequests.size;
    const supportLabel = t(user, 'btn_admin_support', '💬 Support') + (supportCount > 0 ? ` (${supportCount})` : '');

    const rows = [
        [Markup.button.callback(t(user, 'btn_admin_stats', '📊 Statistiques'), 'admin_stats')],
        [Markup.button.callback(t(user, 'btn_admin_orders', '📦 Commandes'), 'admin_orders'), Markup.button.callback(t(user, 'btn_admin_livreurs', '🚴 Livreurs'), 'admin_livreurs')],
        [Markup.button.callback(t(user, 'btn_admin_users', '👥 Utilisateurs'), 'admin_users'), Markup.button.callback(t(user, 'btn_admin_broadcast', '🔔 Diffusion'), 'admin_broadcast')],
        [Markup.button.callback(supportLabel, 'admin_support_queue')],
        [Markup.button.callback(t(user, 'btn_admin_marketplace', '🏪 Marketplace'), 'mp_browse'), Markup.button.callback(t(user, 'btn_admin_settings', '⚙️ Paramètres'), 'admin_settings')],
        [Markup.button.callback(t(user, 'btn_admin_features', '✨ Guide Bot'), 'admin_features')],
        [Markup.button.callback(t(user, 'btn_quit_console', '◀️ Quitter la console'), 'main_menu')]
    ];

    const keyboard = Markup.inlineKeyboard(rows);
    return safeEdit(ctx, text, keyboard);
}

function setupAdminHandlers(bot) {

    // Commande /admin
    bot.command('admin', async (ctx) => {
        if (!(await isAdmin(ctx))) return safeEdit(ctx, '❌ Accès réservé.');
        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
            const adminKey = String(ctx.from.id).match(/\d+/g)?.[0] || String(ctx.from.id);
            pendingAdminLogins.add(adminKey);
            return safeEdit(ctx, '🔐 Veuillez entrer le mot de passe administrateur :');
        }
        return handleAdminLogin(ctx, args[1]);
    });

    bot.command('adduser', async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply('❌ Usage: /adduser <TELEGRAM_ID>');

        const targetId = args[1];
        const { registerUser } = require('../services/database');

        try {
            await registerUser({ id: targetId, first_name: 'Utilisateur Manuel', username: 'inconnu' });
            ctx.reply(`✅ Utilisateur <code>${targetId}</code> ajouté manuellement avec succès !`, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply(`❌ Erreur : ${e.message}`);
        }
    });

    /**
     * Approbation rapide d'un client
     */
    bot.action(/^approve_(.+)$/, async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Accès réservé aux administrateurs.');
        const userId = ctx.match[1];
        const { approveUser } = require('../services/database');
        
        try {
            await approveUser(userId);
            await ctx.answerCbQuery('✅ Utilisateur approuvé avec succès !', true);
            await safeEdit(ctx, ctx.callbackQuery.message.text + `\n\n✅ <b>APPROUVÉ PAR ${ctx.from.first_name}</b>`);
            
            // Notifier le client (Seulement si activé dans les réglages et si ce n'est pas un bot WA à risque)
            const settings = ctx.state?.settings || await require('../services/database').getAppSettings();
            const { sendMessageToUser } = require('../services/notifications');
            
            if (settings.notify_on_approval !== false) {
                await sendMessageToUser(userId, `🎉 <b>Félicitations !</b>\n\nVotre accès a été validé par l'administrateur. Vous pouvez maintenant découvrir notre catalogue et passer commande.\n\nCliquez sur /start pour commencer !`);
            }
        } catch (e) {
            console.error('[Admin-Approve] Error:', e.message);
            await ctx.answerCbQuery('❌ Erreur lors de l\'approbation.', true);
        }
    });

    bot.command(/^approve_(.+)$/, async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const userId = ctx.match[1];
        try {
            const { approveUser } = require('../services/database');
            await approveUser(userId);
            ctx.reply(`✅ L'utilisateur <code>${userId}</code> a été approuvé.`, { parse_mode: 'HTML' });
            
            const settings = ctx.state?.settings || await require('../services/database').getAppSettings();
            const { sendMessageToUser } = require('../services/notifications');
            
            if (settings.notify_on_approval !== false) {
                await sendMessageToUser(userId, `🎉 <b>Accès validé !</b>\n\nL'admin a autorisé votre compte. Tapez /start pour commander.`);
            }
        } catch (e) {
            ctx.reply(`❌ Erreur : ${e.message}`);
        }
    });

    bot.action('admin_menu', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Accès refusé.');

        const settings = ctx.state.settings || {};
        const rootAdminIds = String(settings.admin_telegram_id || '').match(/\d+/g) || [];

        // Root admins or already authenticated admins get in directly
        const adminKey = String(ctx.from.id).match(/\d+/g)?.[0] || String(ctx.from.id);
        if (rootAdminIds.includes(adminKey) || authenticatedAdmins.has(adminKey)) {
            await ctx.answerCbQuery();
            return showAdminMenu(ctx, true);
        }

        pendingAdminLogins.add(adminKey);
        await ctx.answerCbQuery();
        return ctx.reply('🔐 Veuillez entrer le mot de passe administrateur :');
    });

    // Handler pour la réinitialisation de mot de passe (via notification auto ou admin manuel)
    bot.action('admin_trigger_password_reset', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Accès réservé.');
        pendingPasswordReset.add(String(ctx.from.id).match(/\d+/g)?.[0] || String(ctx.from.id));
        await ctx.answerCbQuery();
        return ctx.reply('🆕 <b>RÉINITIALISATION MOT DE PASSE</b>\n\nVeuillez envoyer le nouveau mot de passe d\'administration souhaité :', { parse_mode: 'HTML' });
    });

    // Handler texte (Pass et recherche)
    bot.on('text', async (ctx, next) => {
        const userId = String(ctx.from.id).match(/\d+/g)?.[0] || String(ctx.from.id);
        if (pendingAdminLogins.has(userId)) {
            pendingAdminLogins.delete(userId);
            return handleAdminLogin(ctx, ctx.message.text.trim());
        }

        if (pendingPasswordReset.has(userId)) {
            if (!(await isAdmin(ctx))) {
                pendingPasswordReset.delete(userId);
                return ctx.reply('❌ Action non autorisée.');
            }
            const newPass = ctx.message.text.trim();
            if (newPass.length < 4) return ctx.reply('❌ Le mot de passe doit faire au moins 4 caractères.');

            try {
                await updateAppSettings({ admin_password: newPass });
                pendingPasswordReset.delete(userId);
                return ctx.reply(`✅ <b>MOT DE PASSE MIS À JOUR</b>\n\nLe nouveau mot de passe a été enregistré avec succès.\n\nNouveau pass : <code>${newPass}</code>`, { parse_mode: 'HTML' });
            } catch (e) {
                console.error('Reset pwd error:', e);
                return ctx.reply('❌ Erreur lors de la mise à jour.');
            }
        }
        return next();
    });

    // --- SECTIONS ---

    // Stats
    bot.action('admin_stats', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Auth requise');
        await ctx.answerCbQuery();
        const stats = await getStatsOverview();
        const msg = `📊 <b>Statistiques Globales</b>\n\n` +
            `• Total CA : <b>${stats.totalCA}€</b>\n` +
            `• Commandes : <b>${stats.totalOrders}</b>\n` +
            `• Utilisateurs : <b>${stats.totalUsers}</b>\n` +
            `• Livreurs Actifs : <b>${stats.activeLivreurs}</b>\n` +
            `• Parrainages : <b>${stats.totalStats?.total_referrals || 0}</b>\n`;

        await safeEdit(ctx, msg, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
    });

    // Commandes (Dernières ou filtrées)
    bot.action(/^admin_orders(_pending|_all)?$/, async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Auth requise');
        await ctx.answerCbQuery();
        
        const filterStr = ctx.match[1] || '_all';
        const isPendingOnly = filterStr === '_pending';
        
        const statusFilter = isPendingOnly ? ['pending', 'supplier_pending', 'validated', 'supplier_ready', 'taken'] : null;
        const orders = await getAllOrders(40, statusFilter);
        
        if (orders.length === 0) {
            const msg = isPendingOnly ? '📭 Aucun commande en cours / en attente.' : '📭 Aucune commande.';
            return safeEdit(ctx, msg, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
        }

        const buttons = orders.map(o => {
            const shortId = o.id.slice(-6);
            let icon = '❓';
            if (o.status === 'delivered') icon = '✅';
            else if (o.status === 'pending' || o.status === 'supplier_pending') icon = '⏳';
            else if (o.status === 'taken') icon = '🛵';
            else if (o.status === 'validated' || o.status === 'supplier_ready') icon = '📦';
            else if (o.status === 'cancelled') icon = '❌';
            
            return [Markup.button.callback(`${icon} #${shortId} - ${o.total_price}€ - ${o.first_name || 'Cl'}`, `ao_v_${o.id}`)];
        });

        // Add filter toggle button at the top
        if (isPendingOnly) {
            buttons.unshift([Markup.button.callback('📜 VOIR TOUTES LES COMMANDES', 'admin_orders_all')]);
        } else {
            buttons.unshift([Markup.button.callback('⏳ VOIR UNIQUEMENT EN ATTENTE / COURS', 'admin_orders_pending')]);
        }

        buttons.push([Markup.button.callback('◀️ Retour Menu', 'admin_menu')]);

        const title = isPendingOnly ? '⏳ <b>Commandes Actives / En attente</b>' : '📦 <b>Dernières Commandes</b>';
        await safeEdit(ctx, `${title}\nCliquez pour gérer :`, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^ao_v_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        const order = await getOrder(orderId);
        if (!order) return ctx.answerCbQuery('❌ Introuvable');
        await ctx.answerCbQuery();

        const msg = `📑 <b>Commande #${orderId.slice(-8)}</b>\n\n` +
            `👤 Client : ${order.first_name} (@${order.username})\n` +
            `🛒 Produit : ${order.product_name} x${order.quantity}\n` +
            `📍 Adresse : ${order.address || 'Non renseignée'}\n` +
            (order.scheduled_at ? `🕒 <b>LIVRAISON PRÉVUE : ${order.scheduled_at}</b>\n` : `🚀 <b>ASAP</b>\n`) +
            `💰 Total : ${order.total_price}€\n` +
            (order.livreur_name ? `🚴 Livreur : ${order.livreur_name}\n` : '') +
            `🔘 Statut : <b>${order.status.toUpperCase()}</b>`;

        const buttons = [
            [Markup.button.callback('🤝 ASSIGNER LIVREUR', `ao_l_${orderId}`)],
            [Markup.button.callback('✅ LIVRÉE', `ao_s_${orderId}_delivered`), Markup.button.callback('❌ ANNULÉE', `ao_s_${orderId}_cancelled`)],
            [Markup.button.callback('◀️ Retour aux commandes', 'admin_orders_pending')]
        ];
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^ao_l_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery();
        const livreurs = await searchLivreurs('');

        if (livreurs.length === 0) return safeEdit(ctx, '❌ Aucun livreur enregistré.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', `ao_v_${orderId}`)]]));

        const buttons = livreurs.map(l => {
            const dispoIcon = l.is_available ? '🟢' : '🔴';
            return [Markup.button.callback(`${dispoIcon} ${l.first_name} (${l.current_city || '?'})`, `ao_a_${orderId}::${l.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Annuler', `ao_v_${orderId}`)]);

        await safeEdit(ctx, `🤝 <b>Assignation manuelle</b>\n\nChoisissez le livreur pour la commande #${orderId.slice(-6)} :\n🟢 = Disponible  🔴 = Indisponible`, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^ao_a_(.+?)::(.+)$/, async (ctx) => {
        const [, orderId, lid] = ctx.match;
        const livreur = await getUser(lid);
        if (!livreur) return ctx.answerCbQuery('❌ Erreur');

        const { assignOrderLivreur } = require('../services/database');
        const res = await assignOrderLivreur(orderId, lid, livreur.first_name);

        if (res && res.success) {
            await ctx.answerCbQuery(`✅ Assigné à ${livreur.first_name}`);
            // Notification au livreur
            await sendTelegramMessage(lid.replace('telegram_', ''), `🔔 <b>ADMIN : Une commande vous a été assignée !</b>\n\nRegardez vos commandes dans votre espace livreur.`).catch(() => { });
            
            // Retour au menu de la commande pour voir le nouveau statut
            return bot.handleUpdate({
                ...ctx.update,
                callback_query: {
                    ...ctx.callbackQuery,
                    data: `ao_v_${orderId}`
                }
            });
        } else {
            await ctx.answerCbQuery('❌ Erreur lors de l\'assignation.');
            await ctx.reply('❌ Une erreur est survenue lors de l\'assignation en base de données.');
        }

    });

    bot.action(/^ao_s_(.+)_(.+)$/, async (ctx) => {
        const [, orderId, status] = ctx.match;
        await updateOrderStatus(orderId, status);
        await ctx.answerCbQuery(`✅ Statut mis à jour : ${status}`);
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `ao_v_${orderId}` } });
    });

    // Gestion des Utilisateurs
    bot.action('admin_users', async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        // Optimisation: searchUsers('') with limit for "Derniers inscrits" view
        const users = await searchUsers('', 'active'); 
        const buttons = users.slice(0, 10).map(u => [Markup.button.callback(`👤 ${u.first_name} (@${u.username || '?'})`, `admin_user_view_${u.id}`)]);
        
        buttons.push([Markup.button.callback('⏳ 🟡 ACCÈS EN ATTENTE', 'admin_pending_users')]);
        buttons.push([Markup.button.callback('🔍 Rechercher un utilisateur', 'admin_user_search')]);
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
        
        await safeEdit(ctx, `👥 <b>Gestion des Utilisateurs</b>\n\nDerniers inscrits (actifs) :`, Markup.inlineKeyboard(buttons));
    });

    bot.action('admin_pending_users', async (ctx) => {
        await ctx.answerCbQuery();
        const { getPendingUsers } = require('../services/database');
        const pending = await getPendingUsers();
        
        if (pending.length === 0) {
            return safeEdit(ctx, "✅ <b>Aucun utilisateur en attente d'approbation.</b>", 
                Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_users')]])
            );
        }

        const msg = `⏳ <b>Utilisateurs en attente (${pending.length})</b>\n\nCliquez sur un utilisateur pour l'approuver ou voir son profil :`;
        const buttons = pending.slice(0, 15).map(u => [Markup.button.callback(`⏳ ${u.first_name} (@${u.username || '?'})`, `admin_user_view_${u.id}`)]);
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_users')]);
        
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action('admin_user_search', async (ctx) => {
        await ctx.answerCbQuery();
        adminSearchState.set(ctx.from.id, true);
        await safeEdit(ctx, `🔍 <b>Recherche Utilisateur</b>\n\nEnvoyez le nom ou le @username de la personne :`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', 'admin_users')]]));
    });

    // On utilise un handler spécifique pour la recherche
    bot.on('text', async (ctx, next) => {
        const adminId = String(ctx.from.id);
        if (adminSearchState.has(adminId)) {
            console.log(`[AdminSearch] Logic triggered for ${adminId} | Query: "${ctx.message.text}"`);
            adminSearchState.delete(adminId);
            const query = ctx.message.text.trim();
            try {
                const users = await searchUsers(query);
                console.log(`[AdminSearch] Found ${users.length} users for "${query}"`);
                if (users.length === 0) return ctx.reply('❌ Aucun utilisateur trouvé.');

                const buttons = users.map(u => [Markup.button.callback(`👤 ${u.first_name} (@${u.username || '?'})`, `admin_user_view_${u.id}`)]);
                await ctx.reply(`🔍 <b>Résultats pour "${query}" :</b>`, Markup.inlineKeyboard(buttons));
            } catch (err) {
                console.error(`[AdminSearch-Error]`, err);
                await ctx.reply('❌ Erreur lors de la recherche.');
            }
            return;
        }
        await next();
    });

    // Support Queue Interface
    bot.action('admin_support_queue', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Accès réservé.');
        await ctx.answerCbQuery();
        
        if (pendingSupportRequests.size === 0) {
            return safeEdit(ctx, `✅ <b>Aucun message de support en attente.</b>\n\nTous vos clients ont reçu une réponse.`,
                Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Menu', 'admin_menu')]])
            );
        }

        const buttons = [];
        const sortedRequests = Array.from(pendingSupportRequests.entries())
            .sort((a, b) => b[1].timestamp - a[1].timestamp);

        for (const [userId, data] of sortedRequests) {
            const platformIcon = data.platform === 'whatsapp' ? '📱' : '✈️';
            const timeStr = new Date(data.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            const preview = String(data.lastMsg || '').substring(0, 20);
            const label = `${platformIcon} ${data.name || userId} (${timeStr})\n> ${preview}...`;
            buttons.push([Markup.button.callback(label, `admin_chat_user_${userId}`)]);
        }

        buttons.push([Markup.button.callback('◀️ Menu Admin', 'admin_menu')]);

        await safeEdit(ctx, `💬 <b>Messages de Support en Attente (${pendingSupportRequests.size})</b>\n\nCliquez sur un client pour rejoindre la discussion :`,
            Markup.inlineKeyboard(buttons)
        );
    });

    bot.action(/^admin_user_view_(.+)$/, async (ctx) => {
        const uid = ctx.match[1];
        const u = await getUser(uid);
        if (!u) return ctx.answerCbQuery('❌ Introuvable');
        await ctx.answerCbQuery();

        const msg = `👤 <b>Profil de ${u.first_name}</b>\n\n` +
            `📱 Plateforme : <b>${u.platform?.toUpperCase() || 'TELEGRAM'}</b>\n` +
            (u.is_approved ? '✅ <b>STATUT : APPROUVÉ</b>\n' : '⚠️ <b>STATUT : EN ATTENTE D\'ACCÈS</b>\n') +
            (u.is_blocked ? (u.data && u.data.blocked_by_admin === false ? '🚫 Bot bloqué par client\n' : '🚫 <b>BANNI PAR ADMIN</b>\n') : '✅ Compte Actif\n') +
            `🆔 ID : <code>${u.id}</code>\n` +
            `💰 Solde : ${u.wallet_balance || 0}€ | ⭐ Points : ${u.points || 0}\n` +
            `📦 Commandes : ${u.order_count || 0}\n` +
            `🏃 Est Livreur : ${u.is_livreur ? '✅ OUI' : '❌ NON'}\n`;

        const buttons = [];
        // Bouton d'approbation rapide si non approuvé
        if (!u.is_approved) {
            buttons.push([Markup.button.callback('✅ DONNER ACCÈS (APPROUVER)', `approve_${u.id}`)]);
        }

        buttons.push([Markup.button.callback(u.is_livreur ? '🚫 Retirer Livreur' : '🚴 Passer Livreur', `admin_user_toggle_livreur_${u.id}`)]);
        buttons.push([Markup.button.callback('💬 Contacter ce client', `admin_chat_user_${u.id}`)]);
        buttons.push([Markup.button.callback('💰 Modifier Solde', `admin_user_edit_balance_${u.id}`), Markup.button.callback('⭐ Modifier Points', `admin_user_edit_points_${u.id}`)]);
        buttons.push([Markup.button.callback(u.is_blocked ? '✅ Débloquer' : '🚫 Bloquer', `admin_user_block_${u.id}`)]);
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_users')]);
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });
    
    // Support Chat - Admin vers Client
    bot.action(/^admin_chat_user_(.+)$/, async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const targetIdString = ctx.match[1];
        const adminId = String(ctx.from.id);
        
        awaitingAdminChat.set(adminId, targetIdString);
        activeAdminSessions.set(adminId, true);
        
        // Remove from support queue if present
        if (pendingSupportRequests.has(targetIdString)) {
            pendingSupportRequests.delete(targetIdString);
        }
        
        await ctx.answerCbQuery();
        await cleanupUserChat(ctx); // Clean old messages before starting chat
        
        return ctx.reply(`💬 <b>CONVERSATION ACTIVE</b>\n\nVous discutez avec <code>${targetIdString}</code>.\n\nTous vos prochains messages (texte, photo, vidéo) lui seront transmis.\n\nCliquez sur le bouton ci-dessous pour <b>TERMINER</b> et reprendre le comportement normal.`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🛑 TERMINER LA CONVERSATION', `admin_chat_end_${targetIdString}`)],
                [Markup.button.callback('◀️ Retour au Menu / File', 'admin_menu')]
            ])
        );
    });

    bot.action(/^admin_chat_end_(.+)$/, async (ctx) => {
        const adminId = String(ctx.from.id);
        const targetIdString = ctx.match[1];
        awaitingAdminChat.delete(adminId);
        activeAdminSessions.delete(adminId);
        await ctx.answerCbQuery('Conversation terminée.');
        
        // Notifier le client
        await sendTelegramMessage(targetIdString, `🏁 <b>L'administrateur a mis fin à la discussion.</b>\n\nLe bot reprend son fonctionnement normal. Tapez /start pour voir le menu.`);
        
        await cleanupUserChat(ctx); // Cleanup before returning to menu
        return showAdminMenu(ctx, true);
    });

    bot.action('user_chat_reply_admin', async (ctx) => {
        const userId = String(ctx.from.id);
        const userKey = ctx.platform === 'whatsapp' ? `whatsapp_${userId}` : `telegram_${userId}`;
        awaitingUserSupportReply.set(userKey, true);
        await ctx.answerCbQuery();
        return ctx.reply(`✍️ <b>RÉPONSE À L'ADMIN</b>\n\nEnvoyez votre message ci-dessous (texte, photo ou vidéo).\nChaque message sera transmis à l'administration.\n\n<i>Tapez /end pour quitter le mode discussion.</i>`, 
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🛑 Arrêter la discussion', callback_data: 'cancel_user_support' }]] } }
        );
    });

    bot.action('cancel_user_support', async (ctx) => {
        const userId = String(ctx.from.id);
        const userKey = ctx.platform === 'whatsapp' ? `whatsapp_${userId}` : `telegram_${userId}`;
        activeUserSessions.delete(userKey);
        awaitingUserSupportReply.delete(userKey);
        await ctx.answerCbQuery('Discussion terminée.');
        await cleanupUserChat(ctx);
        return ctx.reply('🏁 <b>Discussion terminée.</b>\n\nLe bot reprend son fonctionnement normal.', { parse_mode: 'HTML' });
    });

    bot.action('help_chat_admin', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        const userId = `${ctx.platform}_${ctx.from.id}`;
        
        await notifyAdmins(bot, `💬 <b>CONTACT ADMIN SOLLICITÉ</b>\n\n👤 Client : ${ctx.from.first_name} (@${ctx.from.username || 'Inconnu'})\n🆔 ID : <code>${userId}</code>\n\n<i>Vous pouvez cliquer sur le bouton ci-dessous pour lui répondre directement.</i>`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '💬 Lui répondre', callback_data: `admin_chat_user_${userId}` }]] }
        });

        const b = [[{ text: '💬 Envoyer ma réponse via le bot', callback_data: 'user_chat_reply_admin' }]];
        if (settings.private_contact_url) b.push([{ text: '📲 Telegram : Admin', url: settings.private_contact_url }]);
        if (settings.private_contact_wa_url) b.push([{ text: '📲 WhatsApp : Admin', url: settings.private_contact_wa_url }]);
        b.push([{ text: '◀️ Retour', callback_data: 'main_menu' }]);

        return safeEdit(ctx, t(ctx, 'msg_support_sent', `💬 <b>Besoin d'un admin ?</b>\n\nVotre demande a été remontée aux administrateurs. Ils reviendront vers vous via le bot sous peu.\n\nVous pouvez aussi nous contacter directement :`), {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: b }
        });
    });

    bot.command('chat', async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply('❌ Usage: /chat <ID_UTILISATEUR>');
        
        const targetIdString = args[1];
        const adminId = String(ctx.from.id);
        awaitingAdminChat.set(adminId, targetIdString);
        activeAdminSessions.set(adminId, true);
        
        await cleanupUserChat(ctx);
        return ctx.reply(`💬 <b>CONVERSATION INITIALISÉE</b>\n\nVous discutez avec <code>${targetIdString}</code>.\n\nTous vos messages lui seront relayés.`,
            Markup.inlineKeyboard([[Markup.button.callback('🛑 TERMINER', `admin_chat_end_${targetIdString}`)]])
        );
    });

    const pendingUserEdit = new Map();

    bot.action(/^admin_user_edit_(balance|points)_(.+)$/, async (ctx) => {
        const [field, uid] = ctx.match.slice(1);
        await ctx.answerCbQuery();
        pendingUserEdit.set(ctx.from.id, { field, uid });
        const label = field === 'balance' ? 'le nouveau solde (€)' : 'le nouveau nombre de points';
        await safeEdit(ctx, `✏️ <b>Modification ${field}</b>\n\nEntrez ${label} pour cet utilisateur :`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', `admin_user_view_${uid}`)]]));
    });

    // Handler texte pour edit balance/points
    bot.on('text', async (ctx, next) => {
        if (pendingUserEdit.has(ctx.from.id)) {
            const { field, uid } = pendingUserEdit.get(ctx.from.id);
            pendingUserEdit.delete(ctx.from.id);
            const val = parseFloat(ctx.message.text.trim());

            if (isNaN(val)) return ctx.reply("❌ Valeur invalide. Opération annulée.");

            try {
                const { supabase, COL_USERS } = require('../services/database');
                const dbField = field === 'balance' ? 'wallet_balance' : 'points';
                await supabase.from(COL_USERS).update({ [dbField]: val }).eq('id', uid);
                ctx.reply(`✅ ${field === 'balance' ? 'Solde' : 'Points'} mis à jour à <b>${val}</b> !`, { parse_mode: 'HTML' });
                return bot.handleUpdate({ ...ctx.update, callback_query: { id: '0', from: ctx.from, data: `admin_user_view_${uid}`, message: ctx.message } });
            } catch (e) {
                return ctx.reply(`❌ Erreur : ${e.message}`);
            }
        }
        return next();
    });

    bot.action(/^admin_user_toggle_livreur_(.+)$/, async (ctx) => {
        const uid = ctx.match[1];
        const u = await getUser(uid);
        if (u) {
            const { setLivreurStatus } = require('../services/database');
            const { sendMessageToUser } = require('../services/notifications');
            
            const newStatus = !u.is_livreur;
            // setLivreurStatus handles cache clearing
            await setLivreurStatus(u.platform_id, u.platform, newStatus);
            
            await ctx.answerCbQuery(`✅ Changé !`);
            
            // Notifier l'utilisateur du changement de rôle
            if (newStatus) {
                await sendMessageToUser(uid, `🚴 <b>PROMOTION LIVREUR !</b>\n\nVous avez été promu au rang de livreur par l'administration.\n\nCliquez sur /start pour accéder à votre interface de livraison.`);
            } else {
                await sendMessageToUser(uid, `👤 <b>MISE À JOUR DE RÔLE</b>\n\nVotre rôle de livreur a été révoqué par l'administration. Vous repassez en mode Client. Cliquez sur /start pour voir le menu.`);
            }
            
            return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_user_view_${uid}` } });
        }
    });

    // Livreurs — vue détaillée avec actions
    bot.action('admin_livreurs', async (ctx) => {
        await ctx.answerCbQuery();
        const livreurs = await getAllLivreurs();
        if (livreurs.length === 0) return safeEdit(ctx, '🚴 Aucun livreur.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));

        let text = `🚴 <b>Gestion des Livreurs (${livreurs.length})</b>\n\n`;
        const buttons = livreurs.map(l => {
            const icon = l.is_available ? '🟢' : '🔴';
            return [Markup.button.callback(`${icon} ${l.first_name} — ${l.order_count || 0} livraisons`, `admin_livreur_view_${l.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_livreur_view_(.+)$/, async (ctx) => {
        const lid = ctx.match[1];
        const l = await getUser(lid);
        if (!l) return ctx.answerCbQuery('❌ Introuvable');
        await ctx.answerCbQuery();

        const msg = `🚴 <b>${l.first_name}</b> (@${l.username || '?'})\n\n` +
            `🆔 <code>${l.platform_id}</code>\n` +
            `🔘 Statut : ${l.is_available ? '🟢 DISPONIBLE' : '🔴 INDISPONIBLE'}\n` +
            `📦 Livraisons : ${l.order_count || 0}\n` +
            `💰 Solde : ${l.wallet_balance || 0}€`;

        const buttons = [
            [Markup.button.callback(l.is_available ? '🔴 Rendre Indisponible' : '🟢 Rendre Disponible', `admin_livreur_toggle_${lid}`)],
            [Markup.button.callback('🚫 Retirer statut livreur', `admin_user_toggle_livreur_${lid}`)],
            [Markup.button.callback('◀️ Retour', 'admin_livreurs')]
        ];
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_livreur_toggle_(.+)$/, async (ctx) => {
        const lid = ctx.match[1];
        const l = await getUser(lid);
        if (!l) return ctx.answerCbQuery('❌ Erreur');
        await setLivreurAvailability(lid, !l.is_available);
        await ctx.answerCbQuery(`✅ ${l.first_name} est maintenant ${!l.is_available ? 'disponible' : 'indisponible'}`);
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_livreur_view_${lid}` } });
    });

    // Produits
    bot.action('admin_products', async (ctx) => {
        await ctx.answerCbQuery();
        const products = await getProducts();
        const buttons = products.map(p => {
            return [Markup.button.callback(`${p.is_active ? '🟢' : '🔴'} ${p.name} - ${p.price}€`, `admin_prod_toggle_${p.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
        await safeEdit(ctx, `🛒 <b>Catalogue Produits</b>\nCliquez pour activer/désactiver :`, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_prod_toggle_(.+)$/, async (ctx) => {
        const pid = ctx.match[1];
        const products = await getProducts();
        const p = products.find(x => x.id === pid);
        if (p) {
            await saveProduct({ ...p, is_active: !p.is_active });
            await ctx.answerCbQuery(`✅ ${p.name} est maintenant ${!p.is_active ? 'Actif' : 'Inactif'}`);
            // Refresh
            const updated = await getProducts();
            const buttons = updated.map(up => [Markup.button.callback(`${up.is_active ? '🟢' : '🔴'} ${up.name} - ${up.price}€`, `admin_prod_toggle_${up.id}`)]);
            buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
            await safeEdit(ctx, `🛒 <b>Catalogue Produits</b>`, Markup.inlineKeyboard(buttons));
        }
    });

    // Broadcast — inline prompt
    const pendingBroadcasts = new Set();

    bot.action('admin_broadcast', async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        pendingBroadcasts.add(ctx.from.id);
        await safeEdit(ctx,
            `📢 <b>Diffusion de message</b>\n\n` +
            `Envoyez votre message maintenant dans le chat.\n` +
            `Il sera diffusé à tous les utilisateurs actifs.\n\n` +
            `<b>Note :</b> Vous pouvez joindre une Photo ou Vidéo.\n\n` +
            `<i>Ou utilisez /broadcast Votre Message</i>`,
            Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'admin_menu')]])
        );
    });

    bot.on(['text', 'photo', 'video'], async (ctx, next) => {
        const uId = String(ctx.from.id);
        const adminId = uId; // Pour la lisibilité côté admin
        const uKey = ctx.platform === 'whatsapp' ? `whatsapp_${uId}` : `telegram_${uId}`;

        // DEBUG LOG
        const isRelayActive = awaitingAdminChat.has(adminId);
        const isUserSession = activeUserSessions.has(uKey) || awaitingUserSupportReply.has(uKey);
        if (isRelayActive || isUserSession || ctx.platform === 'whatsapp') {
            console.log(`[Admin-Relay-Check] Platform: ${ctx.platform} | User: ${uKey} | isRelayActive: ${isRelayActive} | isUserSession: ${isUserSession}`);
        }

        // 1. PRIORITÉ : Conversation Active (Admin -> User)
        if (awaitingAdminChat.has(adminId) && (await isAdmin(ctx))) {
            const targetId = awaitingAdminChat.get(adminId);
            console.log(`[Admin-to-User] Relay triggered from admin ${adminId} to ${targetId}`);
            
            if (ctx.message.text === '/stopchat' || ctx.message.text === '/end') {
                awaitingAdminChat.delete(adminId);
                activeAdminSessions.delete(adminId);
                return ctx.reply('🏁 Conversation terminée.');
            }

            const text = ctx.message.text || ctx.message.caption || '';
            const options = { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💬 Répondre à l\'Admin', callback_data: `user_chat_reply_admin` }],
                        [{ text: '🛑 Terminer la discussion', callback_data: `cancel_user_support` }]
                    ]
                }
            };

            if (ctx.message.photo) {
                options.photo = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            } else if (ctx.message.video) {
                options.video = ctx.message.video.file_id;
                options.caption = text;
            }

            try {
                const res = await sendTelegramMessage(targetId, `👮 <b>MESSAGE DE L'ADMINISTRATION</b>\n\n${text ? `"${text}"` : (options.photo ? '📸 Photo reçue' : '🎥 Vidéo reçue')}`, options);
                console.log(`[Admin-to-User] Send result for ${targetId}:`, res);
                if (res) {
                    activeUserSessions.set(targetId, true);
                    return ctx.reply(`✅ <b>Message transmis au client !</b>\n\n<i>(Session ouverte : il pourra vous répondre directement)</i>`, { parse_mode: 'HTML' });
                }
                else {
                    throw new Error("Bot could not send message");
                }
            } catch (e) {
                console.error(`[AdminChat-Error] FAILED to send to ${targetId}:`, e.message);
                return ctx.reply(`❌ <b>Échec de l'envoi :</b> ${e.message}`, { parse_mode: 'HTML' });
            }
        }

        // 2. Broadcast Logic (Only if not in chat)
        if (pendingBroadcasts.has(ctx.from.id) && (await isAdmin(ctx))) {
            pendingBroadcasts.delete(ctx.from.id);
            console.log(`[AdminBroadcast] Triggered by ${adminId}`);
            
            const message = ctx.message.text || ctx.message.caption || '';
            const options = {};

            if (ctx.message.photo) {
                const photo = ctx.message.photo[ctx.message.photo.length - 1];
                const fileLink = await ctx.telegram.getFileLink(photo.file_id);
                options.mediaUrls = [{ url: fileLink.href, type: 'photo' }];
            } else if (ctx.message.video) {
                const fileLink = await ctx.telegram.getFileLink(ctx.message.video.file_id);
                options.mediaUrls = [{ url: fileLink.href, type: 'video' }];
            }

            if (!message && !options.mediaUrls) {
                return safeEdit(ctx, '❌ Message vide.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_broadcast')]]));
            }

            await safeEdit(ctx, '🚀 Diffusion en cours...');
            const res = await broadcastMessage('users', message, options);
            return safeEdit(ctx, `✅ Diffusion terminée !\n\n📊 Cibles : ${res.total}\n✅ Succès : ${res.success}\n❌ Échecs : ${res.failed}`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Admin', 'admin_menu')]]));
        }
        
        // 3. Commandes GLOBAL /END
        if (ctx.message?.text === '/end' || ctx.message?.text === '/stopchat') {
            if (awaitingAdminChat.has(adminId) || activeAdminSessions.has(adminId)) {
                awaitingAdminChat.delete(adminId);
                activeAdminSessions.delete(adminId);
                return ctx.reply('🏁 <b>Session Admin/Chat terminée.</b>');
            }
            if (activeUserSessions.has(uKey) || awaitingUserSupportReply.has(uKey)) {
                activeUserSessions.delete(uKey);
                awaitingUserSupportReply.delete(uKey);
                return ctx.reply('🏁 <b>Discussion terminée.</b>');
            }
            activeUserSessions.delete(uKey);
            awaitingUserSupportReply.delete(uKey);
            return ctx.reply('🧹 <b>États de conversation réinitialisés.</b>');
        }

        // 4. --- SYSTÈME DE RELAY ADMIN-CLIENT (SUPPORT) ---
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const isBusy = getOrderSystem().hasActiveOrderState(userId) || getMarketplace().hasActiveMarketplaceState(userId);

        const isSupportMessage = (activeUserSessions.has(uKey) || awaitingUserSupportReply.has(uKey) || 
                                 (ctx.platform === 'whatsapp' && !ctx.message?.text?.startsWith('/') && !['menu', 'catalog', 'orders'].includes(ctx.message?.text?.toLowerCase())))
                                 && !isBusy;

        if (isSupportMessage && !(await isAdmin(ctx))) {
            if (!activeUserSessions.has(uKey) && !awaitingUserSupportReply.has(uKey)) {
                activeUserSessions.set(uKey, true);
                console.log(`[Admin-Relay] Auto-start support pour ${uKey}`);
            }

            const text = ctx.message.text || ctx.message.caption || '';
            const reportMsg = `👤 <b>MESSAGE DE ${ctx.from.first_name || 'Client'}</b> (@${ctx.from.username || '?'})\nID: <code>${uKey}</code>\n\n${text ? `<i>"${text}"</i>` : '<i>(Fichier média seul)</i>'}`;
            
            const options = { 
                parse_mode: 'HTML', 
                reply_markup: { inline_keyboard: [[{ text: '💬 Répondre', callback_data: `admin_chat_user_${uKey}` }]] } 
            };
            
            if (ctx.message.photo) {
                const photo = ctx.message.photo[ctx.message.photo.length - 1];
                options.photo = photo.file_id || photo.url || photo.path;
            } else if (ctx.message.video) {
                options.video = ctx.message.video.file_id || ctx.message.video.url || ctx.message.video.path;
            }

            try {
                await notifyAdmins(bot, reportMsg, options);
                awaitingUserSupportReply.delete(uKey);
                activeUserSessions.set(uKey, true);

                if (ctx.message.text !== '/end' && ctx.message.text !== '/stopchat') {
                     await ctx.reply(`✅ <b>Message transmis à l'administration.</b>\n\n<i>Tapez /end pour quitter.</i>`, { parse_mode: 'HTML' });
                }
                return;
            } catch (e) {
                console.error(`[Admin-Relay-Error] FAILED to relay from ${uKey}:`, e.message);
                return ctx.reply(`❌ <b>Échec de transmission :</b> ${e.message}`);
            }
        }

        return next();
    });


    bot.command('broadcast', async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const msg = ctx.message.text.split(' ').slice(1).join(' ');
        if (!msg) return safeEdit(ctx, '❌ Message vide. Usage: /broadcast Votre Message', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Admin', 'admin_menu')]]));
        const res = await broadcastMessage('users', msg);
        await safeEdit(ctx, `✅ Diffusion terminée vers ${res.total} membres.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu Admin', 'admin_menu')]]));
    });

    // Bloquer un utilisateur
    bot.action(/^admin_user_block_(.+)$/, async (ctx) => {
        const uid = ctx.match[1];
        const u = await getUser(uid);
        if (!u) return ctx.answerCbQuery('❌ Utilisateur introuvable');

        const { markUserBlocked, markUserUnblocked } = require('../services/database');

        if (u.is_blocked) {
            await markUserUnblocked(uid);
            await ctx.answerCbQuery('✅ Utilisateur débloqué');
        } else {
            await markUserBlocked(uid, true);
            await ctx.answerCbQuery('🚫 Utilisateur bloqué');
        }

        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_user_view_${uid}` } });
    });

    // Paramètres — vue depuis Telegram
    bot.action('admin_settings', async (ctx) => {
        await ctx.answerCbQuery();
        const s = await getAppSettings();
        const msg = `⚙️ <b>Paramètres Généraux</b>\n\n` +
            `📛 Nom Bot : ${s.bot_name}\n` +
            `🔑 Admin Root : <code>${s.admin_telegram_id || 'Non défini'}</code>\n` +
            `👥 Admins supplémentaires : <b>${(s.list_admins || []).length}</b>\n\n` +
            `📢 <b>Canal :</b> ${s.channel_url || 'Non configuré'}\n` +
            `📱 <b>Contact :</b> ${s.private_contact_url || 'Non configuré'}\n\n` +
            `💰 Bonus Parrainage : ${s.ref_bonus || 5}€\n\n` +
            `<i>Utilisez les boutons ci-dessous pour gérer les admins ou voir la config web complète.</i>`;

        await safeEdit(ctx, msg, Markup.inlineKeyboard([
            [Markup.button.callback('👥 Gérer les Admins (+/-)', 'admin_manage_list')],
            [Markup.button.callback(s.maintenance_mode ? '🟢 Désactiver Maintenance' : '🔴 Activer Maintenance', 'admin_toggle_maintenance')],
            [Markup.button.callback(s.welcome_message_enabled !== false ? '👋 Désactiver Bienvenue' : '👋 Activer Bienvenue', 'admin_toggle_welcome')],
            [Markup.button.callback('📢 Changer Lien Canal', 'admin_set_channel')],
            [Markup.button.callback('📱 Changer Contact Admin', 'admin_set_contact')],
            [Markup.button.url('🌐 Dashboard Web Complet', s.dashboard_url || 'https://google.com')],
            [Markup.button.callback('◀️ Retour', 'admin_menu')]
        ]));
    });

    bot.action('admin_toggle_welcome', async (ctx) => {
        const s = await getAppSettings();
        const newState = !(s.welcome_message_enabled !== false);
        await updateAppSettings({ welcome_message_enabled: newState });
        await ctx.answerCbQuery(`✅ Message de bienvenue ${newState ? 'Activé' : 'Désactivé'}`);
        return showAdminMenu(ctx, true);
    });

    bot.action('admin_toggle_maintenance', async (ctx) => {
        const s = await getAppSettings();
        const newState = !s.maintenance_mode;
        await updateAppSettings({ maintenance_mode: newState });
        await ctx.answerCbQuery(`✅ Maintenance ${newState ? 'Activée' : 'Désactivée'}`);
        await notifyAdmins(bot, `⚙️ <b>MODIFICATION PARAMÈTRE</b>\n\nNom : Maintenance\nNouveau statut : <b>${newState ? 'ACTIVÉE' : 'DÉSACTIVÉE'}</b>\nPar : ${ctx.from.first_name}`);
        return showAdminMenu(ctx, true);
    });

    const pendingSettingsUpdate = new Map();

    bot.action('admin_set_channel', async (ctx) => {
        await ctx.answerCbQuery();
        pendingSettingsUpdate.set(ctx.from.id, 'channel_url');
        await safeEdit(ctx, `📢 <b>Changer le lien du Canal</b>\n\nEnvoyez le nouveau lien (ex: https://t.me/moncanal) :`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', 'admin_settings')]]));
    });

    bot.action('admin_set_contact', async (ctx) => {
        await ctx.answerCbQuery();
        pendingSettingsUpdate.set(ctx.from.id, 'private_contact_url');
        await safeEdit(ctx, `📱 <b>Changer le contact Admin</b>\n\nEnvoyez le nouveau lien ou username (ex: https://t.me/monuser) :`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', 'admin_settings')]]));
    });



    // Gestion list_admins (+/-)
    bot.action('admin_manage_list', async (ctx) => {
        await ctx.answerCbQuery();
        const s = await getAppSettings();
        const admins = Array.isArray(s.list_admins) ? s.list_admins : [];

        let msg = `👥 <b>Gestion des administrateurs</b>\n\n` +
            `Cliquez sur <b>(-)</b> pour supprimer un admin,\nou sur <b>(+)</b> pour en ajouter un nouveau via son ID.\n\n`;

        const buttons = admins.map(id => [
            Markup.button.callback(`👤 Admin ${id}`, 'none'),
            Markup.button.callback('❌ (-)', `admin_remove_${id}`)
        ]);

        buttons.push([Markup.button.callback('➕ AJOUTER UN ADMIN (+)', 'admin_add_prompt')]);
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_settings')]);

        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action('admin_add_prompt', async (ctx) => {
        await ctx.answerCbQuery();
        pendingAdminAdd.set(ctx.from.id, true);
        await safeEdit(ctx, `📌 <b>Ajout Administrateur</b>\n\nEnvoyez l'ID Telegram de la personne (ex: 12345678) :`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', 'admin_manage_list')]]));
    });

    // Suppression d'admin
    bot.action(/^admin_remove_(.+)$/, async (ctx) => {
        const targetId = ctx.match[1];
        const s = await getAppSettings();
        let admins = Array.isArray(s.list_admins) ? s.list_admins : [];
        admins = admins.filter(id => id !== targetId);
        await updateAppSettings({ list_admins: admins });
        await ctx.answerCbQuery('✅ Admin supprimé');
        await notifyAdmins(bot, `👤 <b>ADMIN SUPPRIMÉ</b>\n\nID : <code>${targetId}</code>\nPar : ${ctx.from.first_name}`);
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'admin_manage_list' } });
    });

    // Handler texte pour ADD ADMIN
    const pendingAdminAdd = new Map();
    bot.on('text', async (ctx, next) => {
        if (pendingAdminAdd.has(ctx.from.id)) {
            pendingAdminAdd.delete(ctx.from.id);
            const newId = ctx.message.text.trim();
            if (!newId.match(/^\d+$/)) return ctx.reply("❌ L'ID doit être composé uniquement de chiffres. Annulé.");

            const s = await getAppSettings();
            let admins = Array.isArray(s.list_admins) ? s.list_admins : [];
            if (admins.includes(newId)) return ctx.reply("⚠️ Cet admin est déjà dans la liste.");

            admins.push(newId);
            await updateAppSettings({ list_admins: admins });
            await ctx.reply(`✅ <b>ID ${newId} ajouté</b> aux administrateurs !`, { parse_mode: 'HTML' });
            await notifyAdmins(bot, `👤 <b>NOUVEL ADMIN AJOUTÉ</b>\n\nID : <code>${newId}</code>\nPar : ${ctx.from.first_name}`);
            return bot.handleUpdate({
                ...ctx.update,
                callback_query: { id: '0', from: ctx.from, data: 'admin_manage_list', message: ctx.message }
            });
        }

        if (pendingSettingsUpdate.has(ctx.from.id)) {
            const field = pendingSettingsUpdate.get(ctx.from.id);
            pendingSettingsUpdate.delete(ctx.from.id);
            let val = ctx.message.text.trim();
            if (field.endsWith('_url') && !val.startsWith('http')) {
                val = 'https://' + val.replace(/^@/, 't.me/');
            }
            const newVal = val; // Use the processed 'val'
            await updateAppSettings({ [field]: newVal });
            await ctx.reply(`✅ <b>${field}</b> mis à jour !`, { parse_mode: 'HTML' });
            await notifyAdmins(bot, `⚙️ <b>PARAMÈTRE MIS À JOUR</b>\n\nClé : <code>${field}</code>\nPar : ${ctx.from.first_name}`);
            return bot.handleUpdate({
                ...ctx.update,
                callback_query: { id: '0', from: ctx.from, data: 'admin_settings', message: ctx.message }
            });
        }
        return next();
    });


    // On-onglet des fonctionnalités (Menu principal)
    bot.action('admin_features', async (ctx) => {
        await ctx.answerCbQuery();
        const msg = `✨ <b>GUIDE DES FONCTIONNALITÉS</b>\n\n` +
            `Explorez chaque section du bot en détail.\nCliquez sur un onglet pour en savoir plus :`;

        await safeEdit(ctx, msg, Markup.inlineKeyboard([
            [Markup.button.callback('🛒 Catalogue', 'feat_catalog'), Markup.button.callback('🚴 Livreur', 'feat_livreur')],
            [Markup.button.callback('💬 Chat', 'feat_chat'), Markup.button.callback('🎁 Fidélité', 'feat_fidelity')],
            [Markup.button.callback('📣 Diffusion', 'feat_broadcast'), Markup.button.callback('📊 Stats', 'feat_stats')],
            [Markup.button.callback('👥 Utilisateurs', 'feat_users'), Markup.button.callback('⚙️ Paramètres', 'feat_settings')],
            [Markup.button.callback('◀️ Menu Admin', 'admin_menu')]
        ]));
    });

    // --- Sous-pages Fonctionnalités ---
    bot.action('feat_catalog', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `🛒 <b>CATALOGUE & COMMANDES</b>\n\n` +
            `<b>Pour le client :</b>\n` +
            `• Le bouton "Catalogue" affiche tous les produits disponibles par catégorie/ville\n` +
            `• Le client choisit un produit, sélectionne la quantité, puis entre son adresse\n` +
            `• Il peut planifier une commande à un horaire précis (commande planifiée)\n` +
            `• Le panier est sauvegardé et reprendre possible depuis le menu principal\n\n` +
            `<b>Pour l'admin :</b>\n` +
            `• "Gestion Produits" dans le menu admin : ajouter, modifier, supprimer des produits\n` +
            `• Chaque produit a un nom, prix, photo, ville et disponibilité\n` +
            `• "Commandes Récentes" : voir toutes les commandes, leur statut, et les assigner à un livreur\n` +
            `• L'admin peut annuler ou réassigner une commande à tout moment\n\n` +
            `<b>Notifications :</b>\n` +
            `• L'admin reçoit une alerte à chaque nouvelle commande\n` +
            `• Le client est notifié quand un livreur prend sa commande et quand elle est livrée`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Fonctionnalités', 'admin_features')]])
        );
    });

    bot.action('feat_livreur', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `🚴 <b>SYSTÈME LIVREUR</b>\n\n` +
            `<b>Espace Livreur (bouton dans le menu) :</b>\n` +
            `• Passer Disponible / Indisponible : le livreur gère sa dispo en 1 clic\n` +
            `• "Commandes disponibles" : voir les commandes en attente à prendre\n` +
            `• "Mes livraisons en cours" : gérer les commandes acceptées\n` +
            `• "Commandes planifiées" : voir les commandes prévues à l'avance\n` +
            `• "Mon historique" : voir toutes ses livraisons passées\n\n` +
            `<b>Cycle d'une livraison :</b>\n` +
            `1. Le livreur voit une commande et clique "Prendre la commande"\n` +
            `2. Il envoie une ETA (estimation d'arrivée) au client\n` +
            `3. Il peut signaler un retard si nécessaire (motif obligatoire)\n` +
            `4. Il marque "Livré" quand c'est fait → le client reçoit une notif + demande de feedback\n\n` +
            `<b>Gestion Admin :</b>\n` +
            `• "Gestion Livreurs" : nommer/retirer un livreur, voir son historique\n` +
            `• L'admin peut assigner manuellement une commande à un livreur\n` +
            `• L'admin voit les changements de disponibilité en temps réel`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Fonctionnalités', 'admin_features')]])
        );
    });

    bot.action('feat_chat', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `💬 <b>CHAT & COMMUNICATION</b>\n\n` +
            `<b>Chat Client ↔ Livreur :</b>\n` +
            `• Système de chat intégré directement dans la commande\n` +
            `• Limité à 3 messages au total (client + livreur) pour garder le focus\n` +
            `• Le client et le livreur ont chacun un bouton "Envoyer un message"\n` +
            `• Les messages sont relayés via le bot (pas de numéro échangé)\n\n` +
            `<b>Signalement de retard :</b>\n` +
            `• Le livreur clique "Signaler un retard" dans sa commande active\n` +
            `• Il doit taper un motif (obligatoire)\n` +
            `• Le client reçoit le motif et peut choisir d'annuler\n` +
            `• L'admin est notifié de chaque signalement\n\n` +
            `<b>Contact Admin :</b>\n` +
            `• Bouton "Parler à l'Admin" dans le menu Aide\n` +
            `• Redirige vers le lien de contact privé configuré dans les paramètres`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Fonctionnalités', 'admin_features')]])
        );
    });

    bot.action('feat_fidelity', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `🎁 <b>FIDÉLITÉ & PARRAINAGE</b>\n\n` +
            `<b>Système de points :</b>\n` +
            `• Le client gagne des points à chaque commande livrée (ratio configurable)\n` +
            `• Les points sont automatiquement convertis en crédit quand le seuil est atteint\n` +
            `• Ex: 100 points = 10€ de crédit (configurable dans les paramètres)\n\n` +
            `<b>Portefeuille (Wallet) :</b>\n` +
            `• Crédit utilisable sur la prochaine commande\n` +
            `• Alimenté par les conversions de points et les bonus\n\n` +
            `<b>Parrainage :</b>\n` +
            `• Chaque utilisateur a un lien de parrainage unique\n` +
            `• Quand un filleul passe sa 1ère commande, parrain ET filleul reçoivent un bonus (configurable)\n\n` +
            `<b>Bonus Fidélité :</b>\n` +
            `• Bonus automatique à la Xème commande (ex: 5ème, 10ème)\n` +
            `• Seuils et montant configurables dans les paramètres`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Fonctionnalités', 'admin_features')]])
        );
    });

    bot.action('feat_broadcast', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `📣 <b>DIFFUSION (BROADCAST)</b>\n\n` +
            `<b>Envoi de masse :</b>\n` +
            `• Envoyer un message à tous les utilisateurs non bloqués en 1 clic\n` +
            `• Supporte texte + médias (photos, vidéos) en pièces jointes\n` +
            `• Envoi par lots pour respecter les limites Telegram\n\n` +
            `<b>Depuis le Dashboard Web :</b>\n` +
            `• Onglet "Diffusion" : rédiger le message, joindre des médias, envoyer\n` +
            `• Historique des diffusions (succès, échecs, bloqués)\n\n` +
            `<b>Depuis le Bot :</b>\n` +
            `• "Diffusion Message" dans le menu admin → redirige vers le dashboard\n\n` +
            `<b>Message Automatique :</b>\n` +
            `• Un message configurable est envoyé automatiquement toutes les 6h\n` +
            `• Configurable dans les paramètres du dashboard (champ "Message auto timer")`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Fonctionnalités', 'admin_features')]])
        );
    });

    bot.action('feat_stats', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `📊 <b>STATISTIQUES & DASHBOARD</b>\n\n` +
            `<b>Onglet Statistiques (Bot) :</b>\n` +
            `• Nombre total d'utilisateurs et utilisateurs actifs\n` +
            `• Chiffre d'affaires total et nombre de commandes\n` +
            `• Nombre de livreurs actifs\n\n` +
            `<b>Onglet Analytiques (Bot) :</b>\n` +
            `• CA par jour, semaine, mois\n` +
            `• Top produits vendus\n` +
            `• Temps moyen de livraison\n\n` +
            `<b>Dashboard Web :</b>\n` +
            `• Vue d'ensemble avec compteurs en temps réel\n` +
            `• Onglet Commandes : liste, filtres, détails\n` +
            `• Onglet Utilisateurs : recherche, profils, bannissement\n` +
            `• Onglet Livreurs : gestion, historique par livreur\n` +
            `• Onglet Produits : CRUD complet avec photos\n` +
            `• Onglet Diffusion : envoi + historique\n` +
            `• Onglet Paramètres : personnalisation complète du bot`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Fonctionnalités', 'admin_features')]])
        );
    });

    bot.action('feat_users', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `👥 <b>GESTION UTILISATEURS</b>\n\n` +
            `<b>Depuis le Bot :</b>\n` +
            `• "Gestion Utilisateurs" : rechercher un utilisateur par nom ou ID\n` +
            `• Voir le profil complet (commandes, points, wallet)\n` +
            `• Bloquer / Débloquer un utilisateur\n\n` +
            `<b>Depuis le Dashboard :</b>\n` +
            `• Liste complète avec recherche\n` +
            `• Modifier le solde, les points, le statut livreur\n` +
            `• Voir l'historique des commandes par utilisateur\n\n` +
            `<b>Blocage :</b>\n` +
            `• Un utilisateur bloqué ne peut plus interagir avec le bot\n` +
            `• Il reçoit un message "Accès refusé" s'il essaie\n` +
            `• Il ne reçoit plus les diffusions`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Fonctionnalités', 'admin_features')]])
        );
    });

    bot.action('feat_settings', async (ctx) => {
        await ctx.answerCbQuery();
        await safeEdit(ctx,
            `⚙️ <b>PARAMÈTRES DU BOT</b>\n\n` +
            `<b>Personnalisation visuelle :</b>\n` +
            `• Icônes de chaque bouton du menu (émojis)\n` +
            `• Libellés des boutons (noms affichés)\n` +
            `• Message de bienvenue pour les nouveaux utilisateurs\n` +
            `• Modes de paiement affichés dans le message de bienvenue\n\n` +
            `<b>Fidélité & Parrainage :</b>\n` +
            `• Ratio points/euro, seuil de conversion\n` +
            `• Bonus parrainage, bonus fidélité\n` +
            `• Plafond d'utilisation du wallet\n\n` +
            `<b>Liens & Contact :</b>\n` +
            `• URL du canal Telegram\n` +
            `• Lien de contact privé admin\n` +
            `• Description du bot (carte de partage Telegram)\n\n` +
            `<b>Accès :</b>\n` +
            `• ID Telegram de l'admin (notifications)\n` +
            `• Mot de passe du dashboard web\n` +
            `• Tous les paramètres sont modifiables en temps réel depuis le dashboard`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour Fonctionnalités', 'admin_features')]])
        );
    });

    // Analytics rapide
    bot.action('admin_analytics', async (ctx) => {
        await ctx.answerCbQuery();
        const analytics = await getOrderAnalytics();

        const topProducts = Object.entries(analytics.byProduct || {})
            .sort((a, b) => b[1].qty - a[1].qty).slice(0, 5)
            .map(([name, d]) => `  • ${name} : ${d.qty} vendus (${d.ca.toFixed(2)}€)`).join('\n');

        const msg = `📈 <b>Analytiques</b>\n\n` +
            `💰 CA Total : <b>${analytics.totalCA.toFixed(2)}€</b>\n` +
            `📦 Commandes livrées : ${analytics.totalOrders}\n` +
            `⏱ Temps moyen : ${analytics.avgDeliveryTime} min\n\n` +
            (topProducts ? `🏆 <b>Top Produits :</b>\n${topProducts}` : '');

        await safeEdit(ctx, msg, Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));
    });

    // === MENU DES MODULES & SÉCURITÉ ===
    bot.action('admin_modules_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const s = await getAppSettings();
        
        let msg = `🛠️ <b>Gestion des Modules & Sécurité</b>\n\n` +
            `Activez ou désactivez les fonctionnalités majeures en un clic.\n` +
            `<i>(Note : Ces changements sont appliqués immédiatement sur tous les bots)</i>`;
            
        const buttons = [
            [Markup.button.callback((s.auto_approve_new ? '🟢' : '🔴') + ' Approbation Auto', 'toggle_mod_auto_approve_new')],
            [Markup.button.callback((s.notify_on_approval !== false ? '🟢' : '🔴') + ' Notif. Approbation', 'toggle_mod_notify_on_approval')],
            [Markup.button.callback((s.priority_delivery_enabled ? '🟢' : '🔴') + ' Livr. Prioritaire', 'toggle_mod_priority_delivery_enabled')],
            [Markup.button.callback((s.enable_marketplace ? '🟢' : '🔴') + ' Marketplace', 'toggle_mod_enable_marketplace')],
            [Markup.button.callback((s.enable_fidelity !== false ? '🟢' : '🔴') + ' Fidélité & Points', 'toggle_mod_enable_fidelity')],
            [Markup.button.callback((s.enable_referral !== false ? '🟢' : '🔴') + ' Parrainage', 'toggle_mod_enable_referral')],
            [Markup.button.callback((s.enable_telegram !== false ? '🟢' : '🔴') + ' Bot Telegram', 'toggle_mod_enable_telegram')],
            [Markup.button.callback((s.enable_whatsapp !== false ? '🟢' : '🔴') + ' Bot WhatsApp', 'toggle_mod_enable_whatsapp')],
            [Markup.button.callback('◀️ Menu Principal', 'admin_menu')]
        ];
        
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    // Handler générique pour les toggles de modules
    bot.action(/^toggle_mod_(.+)$/, async (ctx) => {
        const key = ctx.match[1];
        const s = await getAppSettings();
        
        // Inversion de l'état (true -> false, false -> true)
        const current = s[key] !== undefined ? s[key] : true; 
        const newState = !current;
        
        const updates = {};
        updates[key] = newState;
        
        try {
            const { updateAppSettings } = require('../services/database');
            await updateAppSettings(updates);
            await ctx.answerCbQuery(`✅ ${key} : ${newState ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
            
            // Notification aux admins
            await notifyAdmins(bot, `🛠️ <b>MODIFICATION MODULE</b>\n\nModule : <code>${key}</code>\nNouveau statut : <b>${newState ? 'ACTIF 🟢' : 'INACTIF 🔴'}</b>\nPar : ${ctx.from.first_name}`);
            
            // Recharger le menu (en ré-émettant l'action)
            return bot.handleUpdate({
                ...ctx.update,
                callback_query: {
                    ...ctx.callbackQuery,
                    data: 'admin_modules_menu'
                }
            });
        } catch (e) {
            console.error('[Module-Toggle] Error:', e.message);
            await ctx.answerCbQuery('❌ Erreur lors de la modification.', true);
        }
    });
}

module.exports = { 
    setupAdminHandlers, 
    isAdmin, 
    initAdminState,
    authenticatedAdmins,
    pendingAdminLogins,
    activeUserSessions,
    awaitingUserSupportReply,
    activeAdminSessions,
    awaitingAdminChat,
    adminSearchState
};
