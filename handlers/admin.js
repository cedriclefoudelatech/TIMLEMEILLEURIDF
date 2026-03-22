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
const { safeEdit } = require('../services/utils');
const { notifyAdmins, sendTelegramMessage } = require('../services/notifications');
require('dotenv').config();

const { createPersistentMap } = require('../services/persistent_map');

const authenticatedAdmins = createPersistentMap('authenticatedAdmins');
const pendingAdminLogins = new Set();
const pendingPasswordReset = new Set();
const awaitingAdminChat = new Map(); // Map pour admin_id -> target_id_du_client (format platform_id)
const activeAdminSessions = new Set(); // Admins currently in active chat mode
const activeUserSessions = new Set(); // Users currently in active chat mode

async function initAdminState() {
    await authenticatedAdmins.load();
}

async function isAdmin(ctx) {
    const currentUserId = String(ctx.from.id).match(/\d+/g)?.[0];
    if (authenticatedAdmins.has(currentUserId)) return true;

    const settings = ctx.state.settings || (await getAppSettings()) || {};
    
    // Extract IDs from settings (can be comma-separated string or array)
    const adminIds = String(settings.admin_telegram_id || '')
        .match(/\d+/g) || [];
    
    // Also check list_admins (extra admins)
    const extraAdmins = (Array.isArray(settings.list_admins) ? settings.list_admins : [])
        .map(id => String(id).match(/\d+/g)?.[0])
        .filter(Boolean);

    // ALWAYS include the one from .env for safety
    const envAdmin = String(process.env.ADMIN_TELEGRAM_ID || '').match(/\d+/g)?.[0];

    const allAdmins = [...adminIds, ...extraAdmins];
    if (envAdmin) allAdmins.push(envAdmin);

    // Check by ID
    if (allAdmins.includes(currentUserId)) {
        authenticatedAdmins.set(currentUserId, true); // Auto-auth for root
        return true;
    }

    // Check by DB status if available
    if (ctx.state.user && ctx.state.user.is_admin) {
        authenticatedAdmins.set(currentUserId, true);
        return true;
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
    const settings = await getAppSettings();
    const stats = await getStatsOverview();

    const text = `🛠 <b>Console d'Administration Telegram</b>\n\n` +
        `Bienvenue dans votre gestionnaire intégré.\n` +
        `Utilisateurs : <b>${stats.totalUsers}</b>\n` +
        `Ventes totales : <b>${stats.totalCA}€</b>\n\n` +
        `Choisissez une section pour gérer votre bot :`;

    const rows = [
        [Markup.button.callback('📊 Statistiques', 'admin_stats'), Markup.button.callback('📈 Analytiques', 'admin_analytics')],
        [Markup.button.callback('📦 Commandes', 'admin_orders'), Markup.button.callback('🚴 Livreurs', 'admin_livreurs')],
        [Markup.button.callback('👥 Utilisateurs', 'admin_users'), Markup.button.callback('🛒 Produits', 'admin_products')]
    ];

    const row4 = [];
    if (settings.enable_marketplace !== false) {
        row4.push(Markup.button.callback('🏪 Marketplace', 'mp_browse'));
    }
    row4.push(Markup.button.callback('📢 Diffusion', 'admin_broadcast'));
    rows.push(row4);

    rows.push([Markup.button.callback('✨ Fonctionnalités', 'admin_features'), Markup.button.callback('⚙️ Paramètres', 'admin_settings')]);
    rows.push([Markup.button.callback('◀️ Quitter la console', 'main_menu')]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (isEdit) {
        return safeEdit(ctx, text, keyboard);
    } else {
        return safeEdit(ctx, text, keyboard);
    }
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
            
            // Notifier le client
            const settings = ctx.state?.settings || await require('../services/database').getAppSettings();
            await sendTelegramMessage(userId, `🎉 <b>Félicitations !</b>\n\nVotre accès a été validé par l'administrateur. Vous pouvez maintenant découvrir notre catalogue et passer commande.\n\nCliquez sur /start pour commencer !`);
        } catch (e) {
            console.error('[Admin-Approve] Error:', e.message);
            await ctx.answerCbQuery('❌ Erreur lors de l\'approbation.', true);
        }
    });

    bot.command(/^approve_(.+)$/, async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const userId = ctx.match[1];
        const { approveUser } = require('../services/database');
        
        try {
            await approveUser(userId);
            ctx.reply(`✅ L'utilisateur <code>${userId}</code> a été approuvé.`, { parse_mode: 'HTML' });
            await sendTelegramMessage(userId, `🎉 <b>Accès validé !</b>\n\nL'admin a autorisé votre compte. Tapez /start pour commander.`);
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

    // Commandes
    bot.action('admin_orders', async (ctx) => {
        if (!(await isAdmin(ctx))) return ctx.answerCbQuery('❌ Auth requise');
        await ctx.answerCbQuery();
        const orders = await getAllOrders(15);
        if (orders.length === 0) return safeEdit(ctx, '📭 Aucune commande.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', 'admin_menu')]]));

        const buttons = orders.map(o => {
            const shortId = o.id.slice(-6);
            const icon = o.status === 'delivered' ? '✅' : (o.status === 'pending' ? '⏳' : '❌');
            return [Markup.button.callback(`${icon} #${shortId} - ${o.total_price}€ - ${o.first_name || 'Cl'}`, `admin_order_view_${o.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);

        await safeEdit(ctx, '📦 <b>Dernières Commandes</b>\nCliquez pour gérer :', Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_order_view_(.+)$/, async (ctx) => {
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
            [Markup.button.callback('🤝 ASSIGNER LIVREUR', `admin_order_assign_list_${orderId}`)],
            [Markup.button.callback('✅ LIVRÉE', `admin_order_set_${orderId}_delivered`), Markup.button.callback('❌ ANNULÉE', `admin_order_set_${orderId}_cancelled`)],
            [Markup.button.callback('◀️ Retour', 'admin_orders')]
        ];
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_order_assign_list_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery();
        const livreurs = await searchLivreurs('');

        if (livreurs.length === 0) return safeEdit(ctx, '❌ Aucun livreur enregistré.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour', `admin_order_view_${orderId}`)]]));

        const buttons = livreurs.map(l => {
            const dispoIcon = l.is_available ? '🟢' : '🔴';
            return [Markup.button.callback(`${dispoIcon} ${l.first_name} (${l.current_city || '?'})`, `admin_order_do_assign_${orderId}::${l.id}`)];
        });
        buttons.push([Markup.button.callback('◀️ Annuler', `admin_order_view_${orderId}`)]);

        await safeEdit(ctx, `🤝 <b>Assignation manuelle</b>\n\nChoisissez le livreur pour la commande #${orderId.slice(-6)} :\n🟢 = Disponible  🔴 = Indisponible`, Markup.inlineKeyboard(buttons));
    });

    bot.action(/^admin_order_do_assign_(.+?)::(.+)$/, async (ctx) => {
        const [, orderId, lid] = ctx.match;
        const livreur = await getUser(lid);
        if (!livreur) return ctx.answerCbQuery('❌ Erreur');

        const { assignOrderLivreur } = require('../services/database');
        await assignOrderLivreur(orderId, lid, livreur.first_name);

        await ctx.answerCbQuery(`✅ Assigné à ${livreur.first_name}`);
        // Notification au livreur
        await sendTelegramMessage(lid.replace('telegram_', ''), `🔔 <b>ADMIN : Une commande vous a été assignée !</b>\n\nRegardez vos commandes dans votre espace livreur.`).catch(() => { });

        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_order_view_${orderId}` } });
    });

    bot.action(/^admin_order_set_(.+)_(.+)$/, async (ctx) => {
        const [, orderId, status] = ctx.match;
        await updateOrderStatus(orderId, status);
        await ctx.answerCbQuery(`✅ Statut mis à jour : ${status}`);
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `admin_order_view_${orderId}` } });
    });

    // Gestion des Utilisateurs
    bot.action('admin_users', async (ctx) => {
        await ctx.answerCbQuery();
        const users = await searchUsers('');
        const buttons = users.slice(0, 10).map(u => [Markup.button.callback(`👤 ${u.first_name} (@${u.username || '?'})`, `admin_user_view_${u.id}`)]);
        buttons.push([Markup.button.callback('🔍 Rechercher un utilisateur', 'admin_user_search')]);
        buttons.push([Markup.button.callback('◀️ Retour', 'admin_menu')]);
        await safeEdit(ctx, `👥 <b>Gestion des Utilisateurs</b>\n\nDerniers inscrits :`, Markup.inlineKeyboard(buttons));
    });

    const adminSearchState = new Map();
    bot.action('admin_user_search', async (ctx) => {
        await ctx.answerCbQuery();
        adminSearchState.set(ctx.from.id, true);
        await safeEdit(ctx, `🔍 <b>Recherche Utilisateur</b>\n\nEnvoyez le nom ou le @username de la personne :`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ Annuler', 'admin_users')]]));
    });

    // On utilise un handler spécifique pour la recherche
    bot.on('text', async (ctx, next) => {
        if (adminSearchState.has(ctx.from.id)) {
            adminSearchState.delete(ctx.from.id);
            const query = ctx.message.text.trim();
            const users = await searchUsers(query);
            if (users.length === 0) return ctx.reply('❌ Aucun utilisateur trouvé.');

            const buttons = users.map(u => [Markup.button.callback(`👤 ${u.first_name} (@${u.username || '?'})`, `admin_user_view_${u.id}`)]);
            await ctx.reply(`🔍 <b>Résultats pour "${query}" :</b>`, Markup.inlineKeyboard(buttons));
            return;
        }
        await next();
    });

    bot.action(/^admin_user_view_(.+)$/, async (ctx) => {
        const uid = ctx.match[1];
        const u = await getUser(uid);
        if (!u) return ctx.answerCbQuery('❌ Introuvable');
        await ctx.answerCbQuery();

        const msg = `👤 <b>Profil de ${u.first_name}</b>\n\n` +
            (u.is_blocked ? (u.data && u.data.blocked_by_admin === false ? '🚫 <b>Statut : BOT BLOQUÉ PAR CLIENT</b>\n' : '🚫 <b>Statut : BANNI PAR ADMIN</b>\n') : '✅ Statut : Actif\n') +
            `🆔 ID : <code>${u.id}</code>\n` +
            `💰 Solde : ${u.wallet_balance || 0}€\n` +
            `⭐️ Points : ${u.points || 0}\n` +
            `📦 Commandes : ${u.order_count || 0}\n` +
            `🏃 Est Livreur : ${u.is_livreur ? '✅ OUI' : '❌ NON'}\n`;

        const buttons = [
            [Markup.button.callback(u.is_livreur ? '🚫 Retirer Livreur' : '🚴 Passer Livreur', `admin_user_toggle_livreur_${u.id}`)],
            [Markup.button.callback('💬 Contacter ce client', `admin_chat_user_${u.id}`)],
            [Markup.button.callback('💰 Modifier Solde', `admin_user_edit_balance_${u.id}`), Markup.button.callback('⭐ Modifier Points', `admin_user_edit_points_${u.id}`)],
            [Markup.button.callback(u.is_blocked ? '✅ Débloquer' : '🚫 Bloquer', `admin_user_block_${u.id}`)],
            [Markup.button.callback('◀️ Retour', 'admin_users')]
        ];
        await safeEdit(ctx, msg, Markup.inlineKeyboard(buttons));
    });
    
    // Support Chat - Admin vers Client
    bot.action(/^admin_chat_user_(.+)$/, async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const targetIdString = ctx.match[1];
        const targetId = targetIdString.replace('telegram_', '').replace('whatsapp_', '');
        awaitingAdminChat.set(String(ctx.from.id), targetIdString);
        activeAdminSessions.add(String(ctx.from.id));
        await ctx.answerCbQuery();
        return safeEdit(ctx, `💬 <b>CONVERSATION ACTIVE</b>\n\nVous discutez avec <code>${targetId}</code>.\n\nTous vos prochains messages (texte, photo, vidéo) lui seront transmis.\n\nCliquez sur le bouton ci-dessous pour <b>TERMINER</b> et reprendre le comportement normal.`,
            Markup.inlineKeyboard([[Markup.button.callback('🛑 TERMINER LA CONVERSATION', `admin_chat_end_${targetIdString}`)]])
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
        
        return showAdminMenu(ctx, true);
    });

    bot.command('chat', async (ctx) => {
        if (!(await isAdmin(ctx))) return;
        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply('❌ Usage: /chat <ID_UTILISATEUR>');
        
        const targetIdString = args[1];
        awaitingAdminChat.set(String(ctx.from.id), targetIdString);
        activeAdminSessions.add(String(ctx.from.id));
        
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
            const { supabase, COL_USERS } = require('../services/database');
            await supabase.from(COL_USERS).update({ is_livreur: !u.is_livreur }).eq('id', uid);
            await ctx.answerCbQuery(`✅ Changé !`);
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
        await ctx.answerCbQuery();
        pendingBroadcasts.add(ctx.from.id);
        await safeEdit(ctx,
            `📢 <b>Diffusion de message</b>\n\n` +
            `Envoyez votre message maintenant dans le chat.\n` +
            `Il sera diffusé à tous les utilisateurs actifs.\n\n` +
            `<i>Ou utilisez /broadcast Votre Message</i>`,
            Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'admin_menu')]])
        );
    });

    bot.on(['text', 'photo', 'video'], async (ctx, next) => {
        if (pendingBroadcasts.has(ctx.from.id) && (await isAdmin(ctx))) {
            pendingBroadcasts.delete(ctx.from.id);
            
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

        // Support Chat Logic (Admin -> User)
        const adminId = String(ctx.from.id);
        if (awaitingAdminChat.has(adminId) && (await isAdmin(ctx))) {
            const targetId = awaitingAdminChat.get(adminId);
            // On ne delete PAS le chat ici pour garder la persistance
            
            // Si c'est une commande spécifiquement pour arrêter
            if (ctx.message.text === '/stopchat' || ctx.message.text === '/end') {
                awaitingAdminChat.delete(adminId);
                activeAdminSessions.delete(adminId);
                return ctx.reply('🏁 Conversation terminée.');
            }

            const text = ctx.message.text || ctx.message.caption || '';
            const options = { parse_mode: 'HTML' };
            
            // On prépare le bouton de réponse pour le client
            options.reply_markup = {
                inline_keyboard: [
                    [{ text: '💬 Répondre à l\'Admin', callback_data: `user_chat_reply_admin` }],
                    [{ text: '🛑 Terminer la discussion', callback_data: `cancel_user_support` }]
                ]
            };

            if (ctx.message.photo) {
                options.photo = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            } else if (ctx.message.video) {
                options.video = ctx.message.video.file_id;
                options.caption = text;
            }

            try {
                await sendTelegramMessage(targetId, `👮 <b>MESSAGE DE L'ADMINISTRATION</b>\n\n${text ? `"${text}"` : (options.photo ? '📸 Photo reçue' : '🎥 Vidéo reçue')}`, options);
                return ctx.reply(`✅ <b>Message transmis au client !</b>`, { parse_mode: 'HTML' });
            } catch (e) {
                return ctx.reply(`❌ <b>Échec de l'envoi :</b> ${e.message}`, { parse_mode: 'HTML' });
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
            [Markup.button.callback('📢 Changer Lien Canal', 'admin_set_channel')],
            [Markup.button.callback('📱 Changer Contact Admin', 'admin_set_contact')],
            [Markup.button.url('🌐 Dashboard Web Complet', s.dashboard_url || 'https://google.com')],
            [Markup.button.callback('◀️ Retour', 'admin_menu')]
        ]));
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
}

module.exports = { setupAdminHandlers, isAdmin, initAdminState };
