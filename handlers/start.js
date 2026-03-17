const { Markup } = require('telegraf');
const { registerUser, getUser, incrementDailyStat, getAppSettings, addMessageToTrack, getLastMenuId } = require('../services/database');
const { safeEdit } = require('../services/utils');
const { createPersistentMap } = require('../services/persistent_map');
const { isAdmin } = require('./admin');
const { notifyAdmins } = require('../services/notifications');

const pendingReferralInput = createPersistentMap('pendingReferral');

async function initStartState() {
    await pendingReferralInput.load();
}

/**
 * Enregistre les handlers pour la commande /start
 */
function setupStartHandler(bot) {

    bot.command('start', async (ctx) => {
        try {
            const user = ctx.from;
            const settings = ctx.state.settings;
            const docId = `${ctx.platform}_${user.id}`;

            // L'envoi du menu est géré par safeEdit (transition douce)
            // L'effacement du /start entrant est géré par le middleware global

            // Vérifier si un code de parrainage
            let referrerId = null;
            const payload = (ctx.message && ctx.message.text) ? ctx.message.text.split(' ')[1] : null;
            if (payload && payload.startsWith('ref_')) {
                referrerId = payload;
                if (payload.includes(`_${user.id}_`)) referrerId = null;
            }

            const { isNew, user: registeredUser } = await registerUser(user, ctx.platform, referrerId);
            ctx.state.user = registeredUser; // Update state with registered user info
            await incrementDailyStat('start_commands');

            let welcomeText = '';

            // Notification Admin pour les nouveaux
            if (isNew) {
                const newMsg = `👤 <b>NOUVEL UTILISATEUR !</b>\n\n` +
                    `Nom : ${user.first_name}\n` +
                    `Username : @${user.username || 'Inconnu'}\n` +
                    `ID : <code>${user.id}</code>\n` +
                    (referrerId ? `🎁 Parrainé par : <code>${referrerId}</code>` : `🔍 Arrivé en direct`);
                notifyAdmins(bot, newMsg);
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
                        `${settings.welcome_message}\n${paymentLine}\n` +
                        `📍 <i>En utilisant ce service, vous acceptez d'être localisé tacitement.</i>\n\n` +
                        `🔗 <b>Votre lien de parrainage :</b>\n` +
                        `<code>https://t.me/${ctx.botInfo.username}?start=${registeredUser.referral_code}</code>`;
                    if (!referrerId) pendingReferralInput.set(docId, true);
                } else {
                    welcomeText = `👋 <b>Ravi de vous revoir, ${user.first_name} !</b>\n\nVous êtes déjà membre du ${settings.bot_name}.${paymentLine}`;
                }
            }

            const keyboard = registeredUser.is_livreur ? await getLivreurMenuKeyboard(ctx, settings, registeredUser, hasActive) : await getMainMenuKeyboard(ctx, settings, registeredUser);
            await safeEdit(ctx, welcomeText, {
                photo: settings.welcome_photo || null,
                ...keyboard
            });

            // Forcer le bouton "Menu" au lieu de "Démarrer" (Telegram uniquement)
            if (ctx.telegram) {
                ctx.telegram.setChatMenuButton(ctx.chat.id, { type: 'commands' }).catch(() => { });
            }

        } catch (error) {
            console.error('❌ Erreur /start:', error);
        }
    });

    bot.action('private_contact', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state.settings;
        const buttons = [];
        let text = `${settings.ui_icon_contact} <b>${settings.label_contact}</b>`;
        if (settings.private_contact_url) {
            text += `\n\nLien direct : <a href="${settings.private_contact_url}">${settings.private_contact_url}</a>`;
            buttons.push([Markup.button.url('💬 Ouvrir le contact', settings.private_contact_url)]);
        } else {
            buttons.push([Markup.button.callback('⚠️ Lien non configuré', 'main_menu')]);
        }
        buttons.push([Markup.button.callback('◀️ Retour au menu', 'main_menu')]);
        await safeEdit(ctx, text, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
    });

    bot.action('channel_link', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = ctx.state.settings;
        const buttons = [];
        let text = `${settings.ui_icon_channel} <b>${settings.label_channel}</b>`;
        if (settings.channel_url) {
            text += `\n\nLien direct : <a href="${settings.channel_url}">${settings.channel_url}</a>`;
            buttons.push([Markup.button.url('📢 Rejoindre le canal', settings.channel_url)]);
        } else {
            buttons.push([Markup.button.callback('⚠️ Lien non configuré', 'main_menu')]);
        }
        buttons.push([Markup.button.callback('◀️ Retour au menu', 'main_menu')]);
        await safeEdit(ctx, text, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
    });

    bot.action('welcome_message', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        await safeEdit(ctx,
            `🏠 <b>${settings.label_welcome || 'Message d\'accueil'}</b>\n\n${settings.welcome_message}`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Retour au menu', 'main_menu')]])
            }
        );
    });

    bot.action('view_support', async (ctx) => {
        await ctx.answerCbQuery();
        const settings = await getAppSettings();
        await safeEdit(ctx,
            `❓ <b>Aide & Support</b>\n\nBesoin d'assistance ?\n\n- Consultez notre canal pour les nouveautés.\n- Contactez le support direct pour vos commandes.\n- Points et parrainage : tout est disponible dans votre profil.`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Contact Support', 'private_contact')],
                    [Markup.button.callback('◀️ Retour au menu', 'main_menu')]
                ])
            }
        );
    });

    bot.action('my_referrals', async (ctx) => {
        await ctx.answerCbQuery();
        const docId = `${ctx.platform}_${ctx.from.id}`;
        const user = await getUser(docId);
        if (!user) return safeEdit(ctx, '❌ Erreur : Profil non trouvé. Relancez /start', Markup.inlineKeyboard([[Markup.button.callback('🚀 /start', 'start')]]));

        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=${user.referral_code}`;

        const settings = await getAppSettings();
        const ptsExchange = settings.points_exchange || 10;
        const ptsRatio = settings.points_ratio || 1;
        const refBonus = settings.ref_bonus || 5;
        const chunkCredit = 10;
        const chunkPts = ptsExchange * chunkCredit;

        await safeEdit(ctx,
            `${settings.ui_icon_profile} <b>${settings.label_profile}</b>\n\n` +
            `${settings.ui_icon_wallet} Solde Portefeuille : <b>${(user.wallet_balance || 0).toFixed(2)}€</b>\n` +
            `${settings.ui_icon_points} Points Fidélité : <b>${user.points || 0} pts</b>\n\n` +
            `👥 Amis parrainés : <b>${user.referral_count || 0}</b>\n` +
            `🛍️ Commandes totales : <b>${user.order_count || 0}</b>\n\n` +
            `🔗 <b>Votre lien de parrainage :</b>\n` +
            `<code>${refLink}</code>\n\n` +
            `⭐ <b>FIDÉLITÉ :</b> Cumulez des points sur vos achats (<b>${ptsRatio} pt / €</b>).\n` +
            `💰 <b>CAGNOTTE :</b> Échangez vos points contre du crédit : <b>${chunkPts} points = ${chunkCredit}€ offerts</b>.\n` +
            `📈 <b>PALIERS :</b> Bonus spécial à votre <b>${(settings.fidelity_bonus_thresholds || "5,9,10").split(',').join('e, ')}e</b> commande !`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    ...(user.points >= chunkPts ? [[Markup.button.callback(`🎁 Échanger ${chunkPts} pts contre ${chunkCredit}€`, 'exchange_points')]] : []),
                    [Markup.button.callback('◀️ Retour au menu', 'main_menu')]
                ])
            }
        );
    });

    bot.action('exchange_points', async (ctx) => {
        const settings = await require('../services/database').getAppSettings();
        const ptsExchange = settings.points_exchange || 10;
        const chunkCredit = 10;
        const chunkPts = ptsExchange * chunkCredit;

        const docId = `${ctx.platform}_${ctx.from.id}`;
        const userDoc = await getUser(docId);

        if (userDoc && userDoc.points >= chunkPts) {
            const { supabase, COL_USERS } = require('../services/database');
            await supabase.from(COL_USERS).update({
                points: userDoc.points - chunkPts,
                wallet_balance: (userDoc.wallet_balance || 0) + chunkCredit
            }).eq('id', docId);
            await ctx.answerCbQuery(`🎉 Succès ! +${chunkCredit}€ ajoutés.`, { show_alert: true });
        } else {
            return ctx.answerCbQuery(`❌ Points insuffisants (${chunkPts} pts requis).`, { show_alert: true });
        }

        // Simuler le clic sur le profil pour rafraîchir sans handleUpdate
        const user = await getUser(docId);
        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=${user.referral_code}`;
        const refBonus = settings.ref_bonus || 5;
        const ptsRatio = settings.points_ratio || 1;

        const text = `${settings.ui_icon_profile} <b>${settings.label_profile}</b>\n\n` +
            `${settings.ui_icon_wallet} Solde Portefeuille : <b>${(user.wallet_balance || 0).toFixed(2)}€</b>\n` +
            `${settings.ui_icon_points} Points Fidélité : <b>${user.points || 0} pts</b>\n\n` +
            `👥 Amis parrainés : <b>${user.referral_count || 0}</b>\n` +
            `🛍️ Commandes totales : <b>${user.order_count || 0}</b>\n\n` +
            `🔗 <b>Votre lien de parrainage :</b>\n` +
            `<code>${refLink}</code>\n\n` +
            `🎁 <b>PARRAINAGE :</b> Gagnez <b>${refBonus}€</b> chacun (vous et votre ami) dès sa première commande ! 💸\n\n` +
            `⭐ <b>FIDÉLITÉ :</b> Cumulez des points sur vos achats (<b>${ptsRatio} pt / €</b>).\n` +
            `💰 <b>CAGNOTTE :</b> Échangez vos points contre du crédit : <b>${chunkPts} points = ${chunkCredit}€ offerts</b>.`;

        const buttons = [
            ...(user.points >= chunkPts ? [[Markup.button.callback(`🎁 Échanger ${chunkPts} pts contre ${chunkCredit}€`, 'exchange_points')]] : []),
            [Markup.button.callback('◀️ Retour au menu', 'main_menu')]
        ];

        return await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    });

    bot.action('main_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const docId = `${ctx.platform}_${ctx.from.id}`;
        
        // Nettoyage des états en attente (delay/chat)
        try {
            const { awaitingDelayReason, awaitingChatReply } = require('./order_system');
            awaitingDelayReason.delete(docId);
            awaitingChatReply.delete(docId);
        } catch (e) { }

        const settings = await getAppSettings();
        const user = await getUser(docId);

        let text = `📋 <b>Menu principal</b>`;
        let keyboard = await getMainMenuKeyboard(ctx, settings, user);

        // Si livreur → menu spécial
        if (user && user.is_livreur) {
            const { getLivreurOrders } = require('../services/database');
            const activeOrders = await getLivreurOrders(user.id);
            const hasActive = activeOrders.length > 0;
            const city = user?.current_city || user?.data?.current_city || 'Non défini';
            const isAvail = user?.is_available || user?.data?.is_available;

            text = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
                `👤 ${user.first_name || ctx.from.first_name}\n` +
                `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
                `🔘 Statut : <b>${isAvail ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n`;

            if (hasActive) {
                text += `🚀 <b>VOUS AVEZ ${activeOrders.length} COMMANDE(S) EN COURS !</b>\n\n` +
                    activeOrders.map(o => `📦 #${o.id.slice(-5)} - ${o.address || '?'}`).join('\n') +
                    `\n\n<i>Cliquez sur "Mes livraisons en cours" pour les gérer.</i>`;
            }

            keyboard = await getLivreurMenuKeyboard(ctx, settings, user, hasActive);
        }

        await safeEdit(ctx, text, {
            photo: settings.welcome_photo || null,
            ...keyboard
        });
    });

    bot.action('livreur_menu', async (ctx) => {
        await ctx.answerCbQuery();
        const docId = `${ctx.platform}_${ctx.from.id}`;
        const [settings, user] = await Promise.all([getAppSettings(), getUser(docId)]);

        if (!user || !user.is_livreur) {
            return safeEdit(ctx, "❌ Accès réservé aux livreurs.", Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }

        const { getLivreurOrders } = require('../services/database');
        const activeOrders = await getLivreurOrders(user.id);
        const hasActive = activeOrders.length > 0;
        const city = user?.current_city || user?.data?.current_city || 'Non défini';
        const isAvail = user?.is_available || user?.data?.is_available;

        const text = `${settings.ui_icon_livreur} <b>${settings.label_livreur || 'Espace Livreur'}</b>\n\n` +
            `👤 ${user.first_name || ctx.from.first_name}\n` +
            `📍 Secteur : <b>${city.toUpperCase()}</b>\n` +
            `🔘 Statut : <b>${isAvail ? (settings.ui_icon_success || '✅') + ' DISPONIBLE' : (settings.ui_icon_error || '❌') + ' INDISPONIBLE'}</b>\n\n` +
            (hasActive ? `🚀 <b>VOUS AVEZ ${activeOrders.length} COMMANDE(S) EN COURS !</b>` : '');

        const keyboard = await getLivreurMenuKeyboard(ctx, settings, user, hasActive);
        await safeEdit(ctx, text, {
            photo: settings.welcome_photo || null,
            ...keyboard
        });
    });

    // ========== GESTION GPS / LOCALISATION ==========
    bot.on('location', async (ctx) => {
        const userId = `${ctx.platform}_${ctx.from.id}`;
        const loc = ctx.message.location;
        if (!loc) return;

        try {
            const { saveUserLocation } = require('../services/database');
            // Sauvegarder les coordonnées
            await saveUserLocation(userId, loc.latitude, loc.longitude);

            await safeEdit(ctx, '✅ Position enregistrée. Merci !', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'livreur_menu')]]));

            // On pourrait faire un reverse geocoding ici pour avoir la ville exacte si besoin
            // Pour l'instant on garde les coordonnées pour le tracking livreur
        } catch (e) {
            console.error('Location error:', e);
        }
    });

    // ========== GESTION CODE PARRAIN MANUEL ==========
    bot.on('text', async (ctx, next) => {
        const docId = `${ctx.platform}_${ctx.from.id}`;
        const inputText = ctx.message.text.trim();

        // Si pas en attente de code parrain, passer au handler suivant
        if (!pendingReferralInput.has(docId)) return next();
        // Si le texte ne commence pas par ref_, c'est peut-être l'adresse -> passer au suivant
        if (!inputText.startsWith('ref_')) {
            pendingReferralInput.delete(docId);
            return next();
        }

        pendingReferralInput.delete(docId);

        try {
            const db = require('../services/database');
            const { supabase, COL_USERS, COL_REFERRALS } = db;
            const { data: snap } = await supabase.from(COL_USERS).select('*').eq('referral_code', inputText).limit(1);

            if (snap && snap.length > 0 && snap[0].id !== docId) {
                const referrerDoc = snap[0];
                await supabase.from(COL_USERS).update({ referral_count: referrerDoc.referral_count + 1 }).eq('id', referrerDoc.id);
                await supabase.from(COL_USERS).update({ referred_by: referrerDoc.id }).eq('id', docId);
                await supabase.from(COL_REFERRALS).insert([{
                    id: `${Date.now()}-${Math.random()}`,
                    referrer_id: referrerDoc.id,
                    referred_id: docId,
                    created_at: db.ts()
                }]);
                return safeEdit(ctx, '🎉 Code parrainage validé ! Votre parrain a été crédité. Vous gagnerez chacun un bonus à votre première commande.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
            } else {
                return safeEdit(ctx, '❌ Code parrainage invalide ou déjà utilisé.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
            }
        } catch (e) {
            console.error('Referral code error:', e);
            return safeEdit(ctx, '❌ Erreur lors de la validation du code. Réessayez plus tard.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Menu', 'main_menu')]]));
        }
    });
}

async function getMainMenuKeyboard(ctx, settings = null, user = null) {
    if (!settings) settings = ctx.state.settings || {};
    if (!user) user = ctx.state.user;

    const buttons = [
        [Markup.button.callback(`${settings.ui_icon_catalog || '🍔'} ${settings.label_catalog || 'Catalogue Produits'}`, 'view_catalog')],
        [Markup.button.callback(`${settings.ui_icon_orders || '📦'} ${settings.label_my_orders || 'Mes Commandes'}`, 'my_orders')],
        [Markup.button.callback(`${settings.ui_icon_leave_review || '⭐️'} ${settings.label_leave_review || 'Laisser un avis / Commentaire'}`, 'leave_review')],
        [Markup.button.callback(`${settings.ui_icon_view_reviews || '👥'} ${settings.label_view_reviews || 'Consulter les avis'}`, 'view_reviews')],
        [Markup.button.callback(`${settings.ui_icon_contact || '📱'} ${settings.label_contact || 'Contact'}`, 'private_contact')],
        [Markup.button.callback(`${settings.ui_icon_channel || '📢'} ${settings.label_channel || 'Lien Canal Telegram'}`, 'channel_link')],
        [Markup.button.callback(`${settings.ui_icon_welcome || '🏠'} ${settings.label_welcome || 'Message d\'accueil'}`, 'welcome_message')],
        [Markup.button.callback(`${settings.ui_icon_profile || '🎁'} ${settings.label_profile || 'Mon Profil & Parrainage'}`, 'my_referrals')],
        [Markup.button.callback(`${settings.ui_icon_info || 'ℹ️'} ${settings.label_info || 'Informations'}`, 'view_broadcasts')],
        [Markup.button.callback(`${settings.ui_icon_support || '❓'} ${settings.label_support || 'Aide & Support'}`, 'view_support')]
    ];

    // Vérifier si un panier existe pour proposer de le reprendre
    const { userCarts } = require('./order_system');
    const uId = ctx.from.id;
    const cart = userCarts.get(uId);

    if (cart && cart.length > 0) {
        buttons.unshift([Markup.button.callback(settings.btn_cart_resume || '➡️ 🛒 REPRENDRE MON PANIER', 'view_cart')]);
    }

    if (user && user.is_livreur) {
        buttons.push([Markup.button.callback(`${settings.ui_icon_livreur} ${settings.label_livreur}`, 'livreur_menu')]);
    }

    // Boutons Admin
    if (await isAdmin(ctx)) {
        buttons.push([Markup.button.callback(`${settings.ui_icon_admin || '🛠'} ${settings.label_admin_bot || 'Gestion Bot'}`, 'admin_menu')]);
        if (settings.dashboard_url && settings.dashboard_url.startsWith('http')) {
            buttons.push([Markup.button.webApp(`${settings.ui_icon_web || '🔐'} ${settings.label_admin_web || 'Dashboard Web'}`, settings.dashboard_url)]);
        }
    }

    return Markup.inlineKeyboard(buttons);
}

async function getLivreurMenuKeyboard(ctx, settings = null, user = null, hasActiveOrders = false) {
    if (!settings) settings = ctx.state.settings || {};
    if (!user) user = ctx.state.user;

    const isAvail = user?.is_available || user?.data?.is_available;
    const dispoBtn = isAvail
        ? Markup.button.callback(`${settings.ui_icon_error || '❌'} Passer Indisponible`, 'set_dispo_false')
        : Markup.button.callback(`${settings.ui_icon_success || '✅'} Passer Disponible`, 'set_dispo_true');

    const buttons = [
        [dispoBtn]
    ];

    if (hasActiveOrders) {
        buttons.push([Markup.button.callback('🚚 MES LIVRAISONS EN COURS 🔥', 'active_deliveries')]);
    }

    buttons.push([Markup.button.callback(`${settings.ui_icon_orders || '📦'} Commandes disponibles`, 'show_available_orders')]);
    buttons.push([Markup.button.callback('🗓 Commandes planifiées', 'show_planned_orders')]);
    buttons.push([Markup.button.callback('📡 Tracking Live (Aide)', 'tracking_info')]);
    buttons.push([Markup.button.callback(`${settings.ui_icon_stats || '📈'} Mon historique livraisons`, 'my_deliveries')]);
    buttons.push([Markup.button.callback(settings.btn_client_mode || '🛒 Mode Client (commander)', 'client_menu')]);
    buttons.push([Markup.button.callback(settings.btn_back_menu || '◀️ Retour au menu principal', 'main_menu')]);

    // Bouton Admin si le livreur est aussi admin
    if (await isAdmin(ctx)) {
        buttons.push([Markup.button.callback(`${settings.ui_icon_admin || '⚙️'} ${settings.label_admin_bot || 'Gestion Bot'}`, 'admin_menu')]);
    }

    return Markup.inlineKeyboard(buttons);
}

module.exports = { setupStartHandler, initStartState, getLivreurMenuKeyboard, getMainMenuKeyboard };
