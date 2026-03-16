const { supabase } = require('../config/supabase');
const encryption = require('./encryption');

const COL_USERS = 'bot_users';
const COL_BROADCASTS = 'bot_broadcasts';
const COL_STATS = 'bot_stats';
const COL_REFERRALS = 'bot_referrals';
const COL_SETTINGS = 'bot_settings';
const COL_PRODUCTS = 'bot_products';
const COL_ORDERS = 'bot_orders';
const COL_DAILY_STATS = 'bot_daily_stats';
const COL_REVIEWS = 'bot_reviews';

function ts() { return new Date().toISOString(); }

// Simple server-side cache to avoid heavy DB scans on every refresh
const _statsCache = {
    overview: null,
    analytics: null,
    ttl: 30000, // 30 seconds
    lastOverview: 0,
    lastAnalytics: 0
};

// Helper pour simplifier Supabase updates numériques
const incr = (n = 1) => n;
function decryptUser(userData) {
    if (!userData) return null;
    const decrypted = {
        ...userData,
        doc_id: userData.id,
        username: encryption.decrypt(userData.username) || userData.username || '',
        first_name: encryption.decrypt(userData.first_name) || userData.first_name || 'Utilisateur',
        last_name: encryption.decrypt(userData.last_name) || userData.last_name || '',
        platform: userData.platform || (String(userData.id).startsWith('whatsapp') ? 'whatsapp' : 'telegram')
    };

    // Parse JSONB data field
    let meta = userData.data;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
    }
    if (!meta || typeof meta !== 'object') meta = {};
    decrypted.data = meta;

    // is_available: JSONB wins, then root column, then false
    if (meta.is_available !== undefined) {
        decrypted.is_available = !!meta.is_available;
    } else {
        decrypted.is_available = !!userData.is_available;
    }

    // current_city: JSONB wins, then root column, then null
    if (meta.current_city) {
        decrypted.current_city = meta.current_city;
    } else if (userData.current_city) {
        decrypted.current_city = userData.current_city;
    } else {
        decrypted.current_city = null;
    }

    return decrypted;
}
function makeDocId(platform, platformId) { return `${platform}_${platformId}`; }

async function activeUsersQuery(platform, type = null, limit = null) {
    let q = supabase.from(COL_USERS).select('id, platform, platform_id, type, username, first_name, last_name, order_count, wallet_balance, points, date_inscription, is_livreur, is_available, is_blocked, current_city, data').eq('is_blocked', false);
    if (platform && platform !== 'all') q = q.eq('platform', platform);
    if (type === 'livreurs') {
        q = q.eq('is_livreur', true);
    } else if (type === 'user') {
        // Inclure 'user' OU NULL (si non défini) mais exclure explicitement 'group'
        q = q.or('type.is.null,type.eq.user');
    } else if (type === 'group') {
        q = q.eq('type', 'group');
    } else if (type) {
        q = q.eq('type', type);
    }
    if (limit) q = q.limit(limit);
    const { data } = await q;
    return data || [];
}

const _userCache = new Map();

async function registerUser(platformUser, platform = 'telegram', referrerId = null) {
    if (!platform) platform = 'telegram';
    const docId = makeDocId(platform, platformUser.id);
    const nowMs = Date.now();

    let existing = null;
    if (_userCache.has(docId)) {
        existing = _userCache.get(docId).data;
    } else {
        const { data: existingArray } = await supabase.from(COL_USERS).select('*').eq('id', docId).limit(1);
        existing = existingArray && existingArray.length > 0 ? existingArray[0] : null;
    }

    const isGroup = platformUser.type === 'group' || platformUser.type === 'supergroup';

    // Si l'utilisateur existe déjà
    if (existing) {
        // Optimisation : Ne mettre à jour last_active en DB que toutes les 5 minutes
        const lastUpdated = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const needsDbUpdate = (nowMs - lastUpdated) > 300000; // 5 minutes
        const needsTypeHealing = !existing.type;

        if (needsDbUpdate || needsTypeHealing) {
            const updateData = {
                last_active: ts(),
                updated_at: ts(),
                is_active: true
            };

            if (needsTypeHealing) updateData.type = isGroup ? 'group' : 'user';

            // Si on a des infos fraîches sur le nom/username
            if (platformUser.username) updateData.username = !isGroup ? encryption.encrypt(platformUser.username) : platformUser.username;
            if (platformUser.first_name) updateData.first_name = !isGroup ? encryption.encrypt(platformUser.first_name) : platformUser.first_name;

            // Update en tâche de fond (background) pour ne pas ralentir le bot
            supabase.from(COL_USERS).update(updateData).eq('id', docId).then(() => { }, () => { });

            const updatedUser = { ...existing, ...updateData };
            _userCache.set(docId, { data: updatedUser, expire: nowMs + 300000 });
            return { isNew: false, user: decryptUser(updatedUser) };
        }

        return { isNew: false, user: decryptUser(existing) };
    }

    // Nouvel utilisateur
    const newUser = {
        id: docId,
        doc_id: docId,
        platform,
        platform_id: String(platformUser.id || ''),
        type: isGroup ? 'group' : 'user',
        username: !isGroup ? encryption.encrypt(platformUser.username || '') : (platformUser.username || ''),
        first_name: !isGroup ? encryption.encrypt(platformUser.first_name || 'Utilisateur') : (platformUser.first_name || 'Utilisateur'),
        last_name: !isGroup ? encryption.encrypt(platformUser.last_name || '') : '',
        language_code: platformUser.language_code || 'fr',
        date_inscription: ts(),
        last_active: ts(),
        updated_at: ts(),
        is_active: true,
        is_blocked: false,
        referred_by: referrerId || null,
        referral_count: 0,
        order_count: 0,
        points: 0,
        wallet_balance: 0,
        is_available: false,
        current_city: null,
        data: {},
        referral_code: generateReferralCode(platform, platformUser.id || Date.now()),
    };

    const { error: insertError } = await supabase.from(COL_USERS).insert([newUser]);
    if (insertError) {
        if (insertError.code === '23505') {
            const { data: updatedArray } = await supabase.from(COL_USERS).select('*').eq('id', docId).limit(1);
            if (updatedArray && updatedArray.length > 0) {
                return { isNew: false, user: decryptUser(updatedArray[0]) };
            }
        }
        console.error(`❌ Échec INSERT user ${docId}:`, insertError.message);
        throw new Error(`Impossible d'enregistrer l'utilisateur : ${insertError.message}`);
    }

    // Statistiques
    await incrementStat('total_users').catch(() => { });
    await incrementDailyStat('new_users').catch(() => { });

    _userCache.set(docId, { data: newUser, expire: nowMs + 300000 });

    if (referrerId) {
        try {
            const { data: refDocs } = await supabase.from(COL_USERS).select('*').eq('referral_code', referrerId).limit(1);
            if (refDocs && refDocs.length > 0) {
                const referrerDoc = refDocs[0];
                // Update referrer count
                await supabase.from(COL_USERS).update({
                    referral_count: (referrerDoc.referral_count || 0) + 1
                }).eq('id', referrerDoc.id);
                
                // CRITICAL FIX: Link the new user to the ACTUAL referrer ID (docId), not the ref_code
                await supabase.from(COL_USERS).update({
                    referred_by: referrerDoc.id
                }).eq('id', docId);

                _userCache.delete(referrerDoc.id);
                _userCache.delete(docId); // Clear cache for new user to reflect link

                await supabase.from(COL_REFERRALS).insert([{
                    id: `${Date.now()}-${Math.round(Math.random() * 1000)}`,
                    referrer_id: referrerDoc.id,
                    referred_id: docId,
                    created_at: ts()
                }]).catch(() => { });
                await incrementStat('total_referrals').catch(() => { });
            }
        } catch (e) {
            console.error("Error processing referral:", e.message);
        }
    }

    return { isNew: true, user: decryptUser(newUser) };
}

async function getAllActiveUsers(platform = null, type = null) {
    const list = await activeUsersQuery(platform, type);
    console.log(`[DB] getAllActiveUsers(platform=${platform}, type=${type}) -> ${list.length} trouvés`);
    return list.map(d => decryptUser(d));
}

// Nouvelle fonction pour le broadcast : inclut TOUS les utilisateurs (même bloqués)
async function getAllUsersForBroadcast(platform = null, type = null) {
    let q = supabase.from(COL_USERS).select('id, platform, platform_id, type, username, first_name, last_name, order_count, wallet_balance, points, date_inscription, is_livreur, is_available, is_blocked, current_city, data, blocked_at');
    if (platform && platform !== 'all') q = q.eq('platform', platform);
    if (type === 'livreurs') {
        q = q.eq('is_livreur', true);
    } else if (type === 'user') {
        q = q.or('type.is.null,type.eq.user');
    } else if (type === 'group') {
        q = q.eq('type', 'group');
    } else if (type) {
        q = q.eq('type', type);
    }
    const { data } = await q;
    const list = data || [];
    console.log(`[DB] getAllUsersForBroadcast(platform=${platform}, type=${type}) -> ${list.length} trouvés (dont bloqués)`);
    return list.map(d => decryptUser(d));
}
/**
 * Marque un utilisateur comme bloqué.
 * @param {string} docId 
 * @param {boolean} byAdmin true si bloqué par l'admin, false si le bot a été bloqué par l'utilisateur (détecté par broadcast)
 */
async function markUserBlocked(docId, byAdmin = false) {
    const updateData = { is_blocked: true, blocked_at: ts() };
    console.log(`[DB] Marking user ${docId} as BLOCKED (byAdmin: ${byAdmin})`);

    const u = await getUser(docId);
    if (u) {
        const newData = { ...(u.data || {}), blocked_by_admin: byAdmin };
        updateData.data = newData;
    }

    await supabase.from(COL_USERS).update(updateData).eq('id', docId);
    _userCache.delete(docId);
}
async function markUserUnblocked(docId) {
    console.log(`[DB] Marking user ${docId} as UNBLOCKED`);
    const updateData = { is_blocked: false, blocked_at: null };
    const u = await getUser(docId);
    if (u) {
        const newData = { ...(u.data || {}) };
        delete newData.blocked_by_admin;
        updateData.data = newData;
    }
    await supabase.from(COL_USERS).update(updateData).eq('id', docId);
    _userCache.delete(docId);
}
async function deleteUser(docId) {
    await supabase.from(COL_USERS).delete().eq('id', docId);
}
async function incrementOrderCount(docId) {
    const user = await getUser(docId);
    if (user) await supabase.from(COL_USERS).update({ order_count: (user.order_count || 0) + 1 }).eq('id', docId);
    _userCache.delete(docId);
}

async function updateUserWallet(docId, amount) {
    await supabase.from(COL_USERS).update({ wallet_balance: parseFloat(amount) }).eq('id', docId);
    _userCache.delete(docId);
}

async function updateUserPoints(docId, points) {
    points = parseFloat(points) || 0;
    await supabase.from(COL_USERS).update({ points }).eq('id', docId);
    _userCache.delete(docId);

    // Trigger conversion if threshold reached
    const settings = await getAppSettings();
    const threshold = settings.points_exchange || 100;
    const creditValue = settings.points_credit_value || 5;

    if (points >= threshold) {
        const conversions = Math.floor(points / threshold);
        const pointsToDeduce = conversions * threshold;
        const creditToAdd = conversions * creditValue;

        const user = await getUser(docId);
        if (user) {
            await supabase.from(COL_USERS).update({
                points: points - pointsToDeduce,
                wallet_balance: (user.wallet_balance || 0) + creditToAdd
            }).eq('id', docId);
            _userCache.delete(docId);

            try {
                const { getBotInstance } = require('../server');
                const bot = getBotInstance();
                if (bot && user.platform_id) {
                    bot.telegram.sendMessage(user.platform_id, `🎊 <b>Conversion Automatique !</b>\n\nVos ${pointsToDeduce} points ont été convertis en <b>${creditToAdd}€</b> de crédit.\nNouveau solde : <b>${((user.wallet_balance || 0) + creditToAdd).toFixed(2)}€</b> 🚀`, { parse_mode: 'HTML' }).catch(() => { });
                }
            } catch (e) { }
        }
    }
}

// --- Livreurs ---
async function setLivreurStatus(userId, platform, isLivreur) {
    const docId = makeDocId(platform, userId);
    const { error } = await supabase.from(COL_USERS).update({
        is_livreur: isLivreur,
        updated_at: ts()
    }).eq('id', docId);

    if (error) throw new Error(error.message);
    _userCache.delete(docId);
}
async function setLivreurAvailability(docId, isAvailable) {
    const updates = {
        is_available: !!isAvailable,
        updated_at: ts()
    };

    const { data: updated, error: fullError } = await supabase.from(COL_USERS).update(updates).eq('id', docId).select();
    if (fullError) {
        console.error(`❌ DB Error setLivreurAvailability: ${fullError.message}`);
        throw new Error(fullError.message);
    }
    if (updated) console.log(`[DB] Updated row count: ${updated.length}`);

    _userCache.delete(docId);
}

async function updateLivreurPosition(docId, input) {
    const user = await getUser(docId);
    if (!user) return;
    const city = input.toLowerCase();
    const sectors = city.split(',').map(s => s.trim()).filter(s => s.length > 0);

    let meta = user.data || {};
    meta.sectors = sectors;
    meta.current_city = city;
    meta.last_position_update = ts();

    // 1. On ne touche plus à is_available ici pour les séparer
    const updates = {
        current_city: city,
        updated_at: ts()
    };

    const { data: updated, error: fullError } = await supabase.from(COL_USERS).update(updates).eq('id', docId).select();
    if (fullError) {
        console.error(`❌ DB Error updateLivreurPosition: ${fullError.message}`);
        throw new Error(fullError.message);
    }
    if (updated) console.log(`[DB] Updated row count: ${updated.length} for ID: ${docId}`);

    _userCache.delete(docId);
}

async function saveUserLocation(docId, lat, lon, city = null) {
    const user = await getUser(docId);
    if (!user) return;
    let tracked = user.data || {};
    tracked.latitude = lat;
    tracked.longitude = lon;
    tracked.last_gps_update = ts();
    if (city) tracked.current_city = city.toLowerCase();
    await supabase.from(COL_USERS).update({ data: tracked }).eq('id', docId);
    _userCache.delete(docId);
}

async function getActiveLivreursCount() {
    const { data } = await supabase.from(COL_USERS).select('*')
        .eq('is_livreur', true);

    // Check JSONB for is_available as well
    const available = (data || []).map(d => decryptUser(d)).filter(u => u.is_available === true);
    return available.length;
}

async function addMessageToTrack(docId, messageId) {
    const user = await getUser(docId);
    if (!user) return;

    // Stratégie : Garder un historique plus large pour garantir le nettoyage
    let tracked = user.tracked_messages || [];
    if (!tracked.includes(messageId)) {
        tracked.push(messageId);
        // Limiter à 50 messages maximum pour éviter de saturer la DB tout en gardant assez d'historique pour le nettoyage
        if (tracked.length > 50) {
            tracked = tracked.slice(-50); 
        }
    }

    await supabase.from(COL_USERS).update({
        tracked_messages: tracked,
        last_menu_id: messageId
    }).eq('id', docId);

    _userCache.delete(docId);
}

async function getLastMenuId(docId) {
    const user = await getUser(docId);
    return user ? user.last_menu_id : null;
}

// --- Orders ---
async function createOrder(orderData) {
    // SÉCURITÉ : On s'assure que l'utilisateur est bien enregistré avant de créer la commande
    const userId = orderData.user_id;
    try {
        const platform = orderData.platform || (String(userId).startsWith('whatsapp') ? 'whatsapp' : 'telegram');
        const platformId = String(userId).includes('_') ? userId.split('_')[1] : userId;

        await registerUser({
            id: platformId,
            username: orderData.username || 'inconnu',
            first_name: orderData.first_name || 'Inconnu',
            type: 'user'
        }, platform);
    } catch (e) {
        console.error("⚠️ registerUser failed during createOrder:", e.message);
        // Vérifie si l'utilisateur existe quand même (erreur de doublon OK)
        const existingUser = await getUser(userId);
        if (!existingUser) {
            console.error(`❌ Cannot create order: user ${userId} doesn't exist and registration failed`);
            return { order: null, error: new Error("Utilisateur introuvable") };
        }
    }

    const id = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const { data, error } = await supabase.from(COL_ORDERS).insert([{
        id: id,
        ...orderData,
        scheduled_at: orderData.scheduled_at || null,
        status: 'pending',
        created_at: ts(),
        notif_1h_sent: false,
        notif_30m_sent: false
    }]).select();

    // Sauvegarde de l'adresse utilisateur pour l'historique
    if (orderData.address && !error) {
        saveUserAddress(orderData.user_id, orderData.address).catch(e => console.error("⚠️ saveUserAddress error:", e));
    }

    if (error) {
        console.error("Error createOrder", error);
        return { order: null, error };
    }

    await incrementStat('total_orders');
    return { order: data[0], error: null };
}

/**
 * Sauvegarde une adresse dans le profil JSON de l'utilisateur.
 */
async function saveUserAddress(docId, address) {
    if (!address) return;
    const user = await getUser(docId);
    if (!user) return;

    let data = user.data || {};
    let addresses = data.addresses || [];

    // On normalise l'adresse pour éviter les doublons stupides (espaces, casse)
    const normalized = address.trim();
    if (!addresses.includes(normalized)) {
        addresses.push(normalized);
        data.addresses = addresses;

        await supabase.from(COL_USERS).update({ data }).eq('id', docId);
        _userCache.delete(docId);
    }
}

async function getUpcomingPlannedOrders() {
    // On cherche les commandes qui ne sont pas encore livrées/annulées et qui ont un horaire prévu
    const { data, error } = await supabase.from(COL_ORDERS)
        .select('*')
        .not('status', 'in', '("delivered","cancelled")')
        .not('scheduled_at', 'is', null);

    if (error) return [];
    return data;
}

async function markNotifSent(orderId, type) {
    const field = type === '1h' ? 'notif_1h_sent' : 'notif_30m_sent';
    await supabase.from(COL_ORDERS).update({ [field]: true }).eq('id', orderId);
}

async function updateOrderStatus(orderId, status, extraData = {}) {
    if (status === 'delivered') {
        extraData.delivered_at = ts();
        const order = await getOrder(orderId);
        if (order && !order.points_awarded) {
            const user = await getUser(order.user_id);
            if (user) {
                const price = parseFloat(order.total_price) || 0;
                const settings = await getAppSettings();
                const pointsRatio = settings.points_ratio || 1;
                const refBonus = settings.ref_bonus || 5;

                const pointsToAdd = Math.floor(price * pointsRatio);
                const isFirstOrder = user.order_count === 0;

                if (isFirstOrder && user.referred_by) {
                    await updateUserWallet(user.id, (user.wallet_balance || 0) + refBonus);
                    const referrer = await getUser(user.referred_by);
                    if (referrer) {
                        await updateUserWallet(referrer.id, (referrer.wallet_balance || 0) + refBonus);

                        // Notifier le parrain
                        const { getBotInstance } = require('../server');
                        const bot = getBotInstance();
                        if (bot) {
                            const refTgId = String(referrer.id).replace('telegram_', '');
                            bot.telegram.sendMessage(refTgId, `👥 <b>GÉNIAL ! Récompense Parrainage !</b>\n\nVotre ami <b>${user.first_name || 'anonyme'}</b> vient de passer sa première commande.\n\nNous venons de créditer votre portefeuille de <b>+${refBonus.toFixed(2)}€</b>. Partagez encore votre lien ! 🎁`, { parse_mode: 'HTML' }).catch(() => { });
                        }
                    }
                }

                await updateUserPoints(user.id, (user.points || 0) + pointsToAdd);
                const newOrderCount = (user.order_count || 0) + 1;
                await supabase.from(COL_USERS).update({ order_count: newOrderCount }).eq('id', user.id);

                // --- Système de Bonus Fidélité ---
                const thresholds = (settings.fidelity_bonus_thresholds || "5,9,10").split(',').map(t => parseInt(t.trim())).filter(t => !isNaN(t));
                const bonusAmount = parseFloat(settings.fidelity_bonus_amount) || 10;

                if (thresholds.includes(newOrderCount)) {
                    await updateUserWallet(user.id, (user.wallet_balance || 0) + bonusAmount);

                    // Notifier le client du bonus
                    const { getBotInstance } = require('../server');
                    const bot = getBotInstance();
                    if (bot) {
                        const tgId = String(user.id).replace('telegram_', '');
                        bot.telegram.sendMessage(tgId, `🏮 <b>C'EST VOTRE JOUR DE CHANCE ! Bonus Fidélité !</b>\n\nFélicitations pour votre <b>${newOrderCount}ème</b> commande !\n\nEn récompense, votre portefeuille a été crédité de <b>+${bonusAmount.toFixed(2)}€</b>. Merci de votre fidélité ! ⭐️`, { parse_mode: 'HTML' }).catch(() => { });
                    }
                    console.log(`🎁 Bonus fidélité de ${bonusAmount}€ accordé à ${user.id} pour sa ${newOrderCount}ème commande.`);
                }

                _userCache.delete(user.id);
                extraData.points_awarded = true;
            }
        }
    }
    await supabase.from(COL_ORDERS).update({ status, ...extraData, updated_at: ts() }).eq('id', orderId);

    // Notification Admin sur chaque changement
    try {
        const settings = await getAppSettings();
        const label = (status === 'delivered' ? settings.status_delivered_label :
            (status === 'pending' ? settings.status_pending_label :
                (status === 'taken' ? settings.status_taken_label : settings.status_cancelled_label))) || status.toUpperCase();
        const icon = (status === 'delivered' ? settings.ui_icon_success :
            (status === 'pending' ? settings.ui_icon_pending :
                (status === 'taken' ? (settings.ui_icon_taken || '🚚') : settings.ui_icon_error))) || '🔔';

        const alertMsg = `${icon} <b>MISE À JOUR COMMANDE</b>\n\n🆔 ID : <code>#${orderId.slice(-5)}</code>\n🔄 Statut : <b>${label}</b>`;
        const { notifyAdmins } = require('./notifications');
        notifyAdmins(null, alertMsg);
    } catch (e) { }

    if (status === 'delivered') {
        const order = await getOrder(orderId);
        if (order) {
            const price = parseFloat(order.total_price) || 0;
            await addToStat('total_ca', price);
        }
    }
}

async function getOrdersByUser(userId) {
    const { data } = await supabase.from(COL_ORDERS).select('*').eq('user_id', userId).order('created_at', { ascending: false });
    return data || [];
}

async function assignOrderLivreur(orderId, livreurId, livreurName) {
    const update = {
        livreur_id: livreurId || null,
        livreur_name: livreurName || null,
        status: livreurId ? 'taken' : 'pending',
        updated_at: ts()
    };
    await supabase.from(COL_ORDERS).update(update).eq('id', orderId);

    // Notifier Admin
    try {
        const settings = await getAppSettings();
        if ((settings.admin_telegram_id || process.env.ADMIN_TELEGRAM_ID) && livreurId) {
            const { getBotInstance } = require('../server');
            const bot = getBotInstance();
            if (bot) {
                const dbAdmins = String(settings.admin_telegram_id || '').split(/[\s,]+/).map(id => id.trim().replace('telegram_', '')).filter(Boolean);
                const envAdmin = String(process.env.ADMIN_TELEGRAM_ID || '').match(/\d+/g)?.[0];
                const adminIds = [...new Set([...dbAdmins, envAdmin].filter(Boolean))];

                const alertMsg = `🚚 <b>AFFECTATION</b>\n\n🆔 #<code>${orderId.slice(-5)}</code>\n👤 Livreur : <b>${livreurName}</b>`;
                for (const adminId of adminIds) {
                    bot.telegram.sendMessage(adminId, alertMsg, { parse_mode: 'HTML' }).catch(() => { });
                }
            }
        }
    } catch (e) { }
}

async function getClientActiveOrders(userId) {
    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .eq('user_id', userId)
        .in('status', ['pending', 'taken'])
        .order('created_at', { ascending: false });
    return data || [];
}

async function logHelpRequest(orderId, type, message) {
    try {
        const order = await getOrder(orderId);
        if (!order) return;
        const requests = Array.isArray(order.help_requests) ? order.help_requests : [];
        requests.push({ type, message, timestamp: ts() });
        const { error } = await supabase.from(COL_ORDERS).update({ help_requests: requests }).eq('id', orderId);
        if (error) console.error("❌ SQL logHelpRequest failed:", error.message);
    } catch (e) {
        console.error("❌ logHelpRequest error:", e.message);
    }
}

async function saveClientReply(orderId, reply) {
    await supabase.from(COL_ORDERS).update({ client_reply: reply }).eq('id', orderId);
}

async function incrementChatCount(orderId) {
    try {
        const order = await getOrder(orderId);
        if (!order) return 0;

        // Sécurité : si la colonne est absente ou NaN, on force à 0
        let currentCount = parseInt(order.chat_count);
        if (isNaN(currentCount)) currentCount = 0;

        const newCount = currentCount + 1;
        const { error } = await supabase.from(COL_ORDERS).update({ chat_count: newCount }).eq('id', orderId);

        if (error) {
            console.error("❌ SQL incrementChatCount failed:", error.message);
            // Si erreur SQL (colonne manquante), on renvoie quand même un nombre pour ne pas bloquer le relayage
            return newCount;
        }
        return newCount;
    } catch (e) {
        console.error("❌ incrementChatCount error:", e.message);
        return 1;
    }
}

async function saveFeedback(orderId, rating, text) {
    await supabase.from(COL_ORDERS).update({
        feedback_rating: rating,
        feedback_text: text,
        updated_at: ts()
    }).eq('id', orderId);
}

async function setPendingFeedback(userId, orderId, rate) {
    const user = await getUser(userId);
    if (!user) return;
    let meta = user.data || {};
    meta.pending_feedback = { orderId, rate };
    await supabase.from(COL_USERS).update({ data: meta, updated_at: ts() }).eq('id', userId);
    _userCache.delete(userId);
}

async function getAndClearPendingFeedback(userId) {
    const user = await getUser(userId);
    if (!user || !user.data || !user.data.pending_feedback) return null;
    const feedback = user.data.pending_feedback;

    let meta = user.data;
    delete meta.pending_feedback;
    await supabase.from(COL_USERS).update({ data: meta, updated_at: ts() }).eq('id', userId);
    _userCache.delete(userId);
    return feedback;
}

async function getOrder(orderId) {
    const { data } = await supabase.from(COL_ORDERS).select('*').eq('id', orderId).limit(1);
    return data && data.length > 0 ? data[0] : null;
}

async function getAvailableOrders(city = null) {
    let q = supabase.from(COL_ORDERS).select('*').eq('status', 'pending');
    if (city && city !== 'all' && city !== 'non défini') {
        q = q.eq('city', city.toLowerCase());
    }
    const { data } = await q.order('created_at', { ascending: false });
    return data || [];
}

async function getAllOrders(limit = 50) {
    const { data } = await supabase.from(COL_ORDERS).select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
}

async function getLivreurHistory(livreurId) {
    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .eq('livreur_id', livreurId)
        .eq('status', 'delivered')
        .order('created_at', { ascending: false });
    return data || [];
}

async function getLivreurOrders(livreurId) {
    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .eq('livreur_id', livreurId)
        .eq('status', 'taken');
    return data || [];
}

async function getUser(docId) {
    if (_userCache.has(docId)) {
        const cached = _userCache.get(docId);
        if (Date.now() < cached.expire) {
            return decryptUser(cached.data);
        }
    }

    const { data } = await supabase.from(COL_USERS).select('*').eq('id', docId).limit(1);
    const rawData = data && data.length > 0 ? data[0] : null;

    if (rawData) {
        _userCache.set(docId, { data: rawData, expire: Date.now() + 300000 }); // 5 minutes cache
        return decryptUser(rawData);
    }
    return null;
}

async function getUserCount(platform = null) {
    let q = supabase.from(COL_USERS).select('*', { count: 'exact', head: true });
    if (platform) q = q.eq('platform', platform);
    const { count } = await q;
    return count || 0;
}
async function getActiveUserCount(platform = null) {
    let q = supabase.from(COL_USERS).select('*', { count: 'exact', head: true }).eq('is_blocked', false).eq('is_active', true);
    if (platform) q = q.eq('platform', platform);
    const { count } = await q;
    return count || 0;
}
async function getRecentUsers(limit = 20) {
    const { data } = await supabase.from(COL_USERS).select('*').order('last_active', { ascending: false }).limit(limit);
    return (data || []).map(decryptUser);
}
async function searchUsers(query) {
    // Exact match by ID first (snappy)
    if (query && (query.startsWith('telegram_') || query.startsWith('whatsapp_') || !isNaN(query.replace('@', '')))) {
        let idToSearch = query;
        if (!query.includes('_') && !query.includes('@')) {
            // Try both default prefixes if it's just a number
            const { data: exact } = await supabase.from(COL_USERS).select('*')
                .or(`id.eq.telegram_${query},id.eq.whatsapp_${query},platform_id.eq.${query}`)
                .limit(5);
            if (exact && exact.length > 0) return exact.map(decryptUser);
        } else {
            const { data: exact } = await supabase.from(COL_USERS).select('*')
                .or(`id.eq.${query},platform_id.eq.${query}`)
                .limit(5);
            if (exact && exact.length > 0) return exact.map(decryptUser);
        }
    }

    // Otherwise fetch a larger batch and filter in memory (for encrypted names)
    // Augmentation de la limite à 2000 pour retrouver les anciens utilisateurs
    const { data } = await supabase.from(COL_USERS).select('*').order('last_active', { ascending: false }).limit(2000);
    const decrypted = (data || []).map(decryptUser);

    if (!query) return decrypted.slice(0, 50);

    const q = query.toLowerCase().replace('@', '');
    return decrypted.filter(u => {
        const uid = String(u.id || '').toLowerCase();
        const uname = String(u.username || '').toLowerCase();
        const fname = String(u.first_name || '').toLowerCase();
        const pid = String(u.platform_id || '').toLowerCase();

        return uid.includes(q) || uname.includes(q) || fname.includes(q) || pid.includes(q);
    }).slice(0, 50);
}

async function searchLivreurs(query) {
    const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true).limit(200);
    const decrypted = (data || []).map(decryptUser);

    if (!query) return decrypted.slice(0, 50);

    const q = query.toLowerCase().replace('@', '');
    return decrypted.filter(u => {
        const uid = String(u.id || '').toLowerCase();
        const uname = String(u.username || '').toLowerCase();
        const fname = String(u.first_name || '').toLowerCase();
        const pid = String(u.platform_id || '').toLowerCase();

        return uid.includes(q) || uname.includes(q) || fname.includes(q) || pid.includes(q);
    }).slice(0, 50);
}

async function getDetailedLivreurActivity(livreurId) {
    if (!livreurId) return [];
    // Ensure format matches livreur_id in orders (e.g. telegram_123)
    const docId = (livreurId.includes('_') || livreurId.startsWith('t_')) ? livreurId : `telegram_${livreurId}`;

    // We try both formats just in case some orders have the raw ID
    const rawId = livreurId.replace('telegram_', '');

    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .or(`livreur_id.eq.${docId},livreur_id.eq.${rawId},livreur_id.eq.${livreurId}`)
        .order('created_at', { ascending: false })
        .limit(100);

    return data || [];
}

function generateReferralCode(platform, platformId) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return `ref_${platform}_${platformId}_${code}`;
}

async function getReferralLeaderboard(limit = 10) {
    const { data } = await supabase.from(COL_USERS).select('*').gt('referral_count', 0).order('referral_count', { ascending: false }).limit(limit);
    return (data || []).map(decryptUser);
}

// --- Stats ---
async function incrementStat(name) {
    const { data } = await supabase.from(COL_STATS).select('*').eq('id', 'global').limit(1);
    const globalStats = data && data.length > 0 ? data[0] : { id: 'global' };
    const val = (globalStats[name] || 0) + 1;
    await supabase.from(COL_STATS).upsert({ ...globalStats, [name]: incr(val), id: 'global' });
}

async function addToStat(name, amount) {
    const { data } = await supabase.from(COL_STATS).select('*').eq('id', 'global').limit(1);
    const globalStats = data && data.length > 0 ? data[0] : { id: 'global' };
    const val = (parseFloat(globalStats[name]) || 0) + parseFloat(amount);
    await supabase.from(COL_STATS).upsert({ ...globalStats, [name]: val, id: 'global' });
}

async function incrementDailyStat(name) {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase.from(COL_DAILY_STATS).select('*').eq('id', `daily_${today}`).limit(1);
    const daily = data && data.length > 0 ? data[0] : { id: `daily_${today}`, date: today };
    const val = (daily[name] || 0) + 1;
    await supabase.from(COL_DAILY_STATS).upsert({ ...daily, [name]: val, id: `daily_${today}`, date: today });
}

async function getGlobalStats() {
    const { data } = await supabase.from(COL_STATS).select('*').eq('id', 'global').limit(1);
    return data && data.length > 0 ? data[0] : {};
}

async function getDailyStats(days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const { data } = await supabase.from(COL_DAILY_STATS)
        .select('*')
        .gte('date', cutoff.toISOString().split('T')[0])
        .order('date', { ascending: true });
    return data || [];
}

async function getStatsOverview() {
    const now = Date.now();
    if (_statsCache.overview && (now - _statsCache.lastOverview < _statsCache.ttl)) {
        return _statsCache.overview;
    }

    const total = await getUserCount();
    const active = await getActiveUserCount();
    const stats = await getGlobalStats();
    const { data: bcSnap } = await supabase.from(COL_BROADCASTS).select('id, created_at, success, failed, message').order('created_at', { ascending: false }).limit(5);

    // Optimized count for active drivers (direct query, no memory decryption needed)
    const { count: activeLivreurs } = await supabase.from(COL_USERS)
        .select('*', { count: 'exact', head: true })
        .eq('is_livreur', true)
        .eq('is_available', true);

    const { count: totalLivreurs } = await supabase.from(COL_USERS)
        .select('*', { count: 'exact', head: true })
        .eq('is_livreur', true);

    // Get CA from Sum of delivered orders (more reliable than just global_stats)
    const { data: caData } = await supabase.from(COL_ORDERS).select('total_price').eq('status', 'delivered');
    const calculatedCA = (caData || []).reduce((acc, curr) => acc + (parseFloat(curr.total_price) || 0), 0);

    const totalCA = calculatedCA || parseFloat(stats.total_ca || stats.global?.total_ca || 0);

    // Get total count of all orders separately if needed, or just delivered
    const { count: totalOrdersCount } = await supabase.from(COL_ORDERS).select('*', { count: 'exact', head: true });

    const result = {
        totalUsers: total,
        activeUsers: active,
        totalStats: stats,
        totalOrders: totalOrdersCount || 0,
        totalCA: totalCA.toFixed(2),
        totalLivreurs: totalLivreurs || 0,
        activeLivreurs: activeLivreurs,
        recentBroadcasts: bcSnap || []
    };

    _statsCache.overview = result;
    _statsCache.lastOverview = now;
    return result;
}

async function getOrderAnalytics() {
    const now = Date.now();
    if (_statsCache.analytics && (now - _statsCache.lastAnalytics < _statsCache.ttl)) {
        return _statsCache.analytics;
    }

    // Limit to last 2000 orders to keep it snappy.
    const { data: ordersSnap } = await supabase.from(COL_ORDERS)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(2000);

    const analytics = {
        totalCA: 0,
        totalOrders: 0,
        avgDeliveryTime: 0,
        byPlatform: {
            telegram: { ca: 0, count: 0, products: {} },
            whatsapp: { ca: 0, count: 0, products: {} }
        },
        byHour: {}, byDay: {}, byWeek: {}, byMonth: {}, byYear: {}, byCity: {}, byDriver: {}, byUser: {}, byProduct: {},
        rawDelivered: []
    };

    let totalDeliveryMinutes = 0;
    let deliveryCount = 0;

    (ordersSnap || []).forEach(order => {
        if (order.status !== 'delivered') return;

        const price = parseFloat(order.total_price) || 0;
        analytics.totalCA += price;
        analytics.totalOrders++;

        // Platform metrics
        const platform = order.platform || (String(order.user_id).startsWith('whatsapp') ? 'whatsapp' : 'telegram');
        if (!analytics.byPlatform[platform]) {
            analytics.byPlatform[platform] = { ca: 0, count: 0, products: {} };
        }
        analytics.byPlatform[platform].ca += price;
        analytics.byPlatform[platform].count++;

        let deliveryMinutes = null;
        if (order.created_at && order.delivered_at) {
            const createdMs = new Date(order.created_at).getTime();
            const deliveredMs = new Date(order.delivered_at).getTime();
            deliveryMinutes = Math.round((deliveredMs - createdMs) / 60000);
            if (deliveryMinutes > 0 && deliveryMinutes < 1440) {
                totalDeliveryMinutes += deliveryMinutes;
                deliveryCount++;
            }
        }

        const clientId = order.user_id || 'unknown';
        const clientName = order.first_name || order.username || 'Client Inconnu';
        if (!analytics.byUser[clientName]) {
            analytics.byUser[clientName] = { count: 0, ca: 0 };
        }
        analytics.byUser[clientName].count++;
        analytics.byUser[clientName].ca += price;

        const driverName = order.livreur_name || 'Inconnu';
        if (!analytics.byDriver[driverName]) {
            analytics.byDriver[driverName] = { count: 0, ca: 0 };
        }
        analytics.byDriver[driverName].count++;
        analytics.byDriver[driverName].ca += price;

        const productName = order.product_name || 'Inconnu';
        if (!analytics.byProduct[productName]) {
            analytics.byProduct[productName] = { qty: 0, ca: 0 };
        }
        analytics.byProduct[productName].qty += (parseInt(order.quantity) || 1);
        analytics.byProduct[productName].ca += price;

        // Best seller per platform
        if (!analytics.byPlatform[platform].products[productName]) {
            analytics.byPlatform[platform].products[productName] = 0;
        }
        analytics.byPlatform[platform].products[productName] += (parseInt(order.quantity) || 1);
        analytics.byProduct[productName].ca += price;

        if (order.created_at) {
            const date = new Date(order.created_at);
            const hour = date.getHours() + 'h';
            analytics.byHour[hour] = (analytics.byHour[hour] || 0) + price;

            const day = date.toISOString().split('T')[0];
            analytics.byDay[day] = (analytics.byDay[day] || 0) + price;

            const year = date.getFullYear();
            const oneJan = new Date(year, 0, 1);
            const weekNum = Math.ceil((((date - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
            const weekKey = `${year}-W${weekNum}`;
            analytics.byWeek[weekKey] = (analytics.byWeek[weekKey] || 0) + price;

            const month = date.toISOString().substring(0, 7);
            analytics.byMonth[month] = (analytics.byMonth[month] || 0) + price;

            const yr = date.getFullYear().toString();
            analytics.byYear[yr] = (analytics.byYear[yr] || 0) + price;
        }

        const city = (order.city || 'Inconnue').split(',')[0].trim().toUpperCase();
        analytics.byCity[city] = (analytics.byCity[city] || 0) + price;

        analytics.rawDelivered.push({
            id: order.id,
            date: order.created_at ? new Date(order.created_at).toLocaleString('fr-FR') : '?',
            delivered_date: order.delivered_at ? new Date(order.delivered_at).toLocaleString('fr-FR') : null,
            delivery_time: deliveryMinutes,
            client: clientName,
            product: order.product_name,
            qty: order.quantity,
            price: price,
            city: city,
            livreur: order.livreur_name || 'N/A'
        });
    });

    analytics.avgDeliveryTime = deliveryCount > 0 ? Math.round(totalDeliveryMinutes / deliveryCount) : 0;

    _statsCache.analytics = analytics;
    _statsCache.lastAnalytics = now;
    return analytics;
}

async function getAvailableLivreurs() {
    const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true);
    return (data || []).map(d => decryptUser(d)).filter(l => l.is_available);
}

async function getAllLivreurs() {
    const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true);
    return (data || []).map(d => decryptUser(d));
}

// --- Settings ---
const SETTINGS_DEFAULTS = {
    bot_name: 'Mon Shop',
    dashboard_title: 'Mon Shop - Admin',
    welcome_message: 'Bienvenue ! Vous faites partie de la famille.',
    admin_password: process.env.ADMIN_PASSWORD || 'timlemeilleur2024',
    admin_telegram_id: String(process.env.ADMIN_TELEGRAM_ID || ''),
    ui_icon_catalog: '👟',
    ui_icon_orders: '📦',
    ui_icon_contact: '📱',
    ui_icon_channel: '📢',
    ui_icon_welcome: '🏠',
    ui_icon_profile: '🎁',
    ui_icon_admin: '🛠',
    ui_icon_web: '🔐',
    ui_icon_livreur: '🚴',
    ui_icon_success: '✅',
    ui_icon_error: '❌',
    ui_icon_pending: '⏳',
    ui_icon_notification: '🔔',
    ui_icon_wallet: '💰',
    ui_icon_points: '⭐',
    ui_icon_stats: '📊',
    ui_icon_broadcast: '📣',
    ui_icon_info: 'ℹ️',
    ui_icon_logout: '🚪',
    ui_icon_taken: '🚚',
    ui_icon_help: '❓',
    ui_icon_review: '⭐️',
    ui_icon_reviews_list: '👥',
    label_catalog: 'Catalogue Produits',
    label_my_orders: 'Mes Commandes',
    label_contact: 'Contact Admin',
    label_channel: 'Lien Canal Telegram',
    label_welcome: 'Message d\'accueil',
    label_profile: 'Mon Profil / Parrainage',
    label_admin_bot: 'Gestion Bot',
    label_admin_web: 'Dashboard Web',
    label_livreur: 'Espace Livreur',
    label_livreur_space: 'Espace Livreur',
    label_help: 'Aide & Support',
    label_broadcasts: 'Informations',
    label_leave_review: 'Laisser un avis',
    label_view_reviews: 'Consulter les avis',
    show_broadcasts_btn: true,
    show_reviews_btn: true,
    status_pending_label: 'Attente Validation',
    status_taken_label: 'En cours de livraison',
    status_delivered_label: 'Livré ✅',
    status_cancelled_label: 'Annulé ❌',
    msg_auto_timer: '🔥 <b>Le catalogue est à jour !</b>\nProfitez de nos nouveaux produits et de nos promos en cours. 🚀',
    msg_choose_qty: 'Choisissez la quantité souhaitée :',
    msg_search_livreur: '⏳ Recherche d\'un livreur en cours...',
    msg_order_success: '✅ <b>Commande enregistrée !</b>',
    msg_help_intro: 'Besoin d\'aide ? Choisissez une option ci-dessous :',
    points_exchange: 100,
    points_ratio: 1,
    ref_bonus: 5,
    points_credit_value: 10,
    fidelity_wallet_max_pct: 50,
    fidelity_min_spend: 50,
    fidelity_bonus_thresholds: '5,10,15,20',
    fidelity_bonus_amount: 10,
    list_admins: [],
    dashboard_url: process.env.DASHBOARD_URL || 'https://timlemeilleuridf-production.up.railway.app',
    private_contact_url: 'https://t.me/Lejardinidf',
    channel_url: 'https://t.me/timlemeilleuridf_canal',
    bot_description: '',
    bot_short_description: '',
    payment_modes: '💵 Espèces',
    maintenance_mode: false,
    maintenance_message: '🔧 <b>Le bot est actuellement en maintenance.</b>\n\nNous revenons bientôt !\n\nContactez l\'admin : @Lejardinidf',
    maintenance_contact: 'https://t.me/Lejardinidf'
};

let _settingsCache = null;
let _settingsExpire = 0;

async function getAppSettings() {
    if (_settingsCache && Date.now() < _settingsExpire) {
        return _settingsCache;
    }

    const { data } = await supabase.from(COL_SETTINGS).select('*').eq('id', 'default').limit(1);
    let settings = { ...SETTINGS_DEFAULTS };

    if (!data || data.length === 0) {
        await supabase.from(COL_SETTINGS).insert([{ id: 'default', ...SETTINGS_DEFAULTS }]);
    } else {
        // Robust merging: Only use DB values if they are NOT null or undefined
        const dbSettings = data[0];
        for (const key in dbSettings) {
            if (dbSettings[key] !== null && dbSettings[key] !== undefined) {
                settings[key] = dbSettings[key];
            }
        }
    }

    // Force string for key fields that might be stored as arrays in JSONB
    if (Array.isArray(settings.admin_telegram_id)) {
        settings.admin_telegram_id = settings.admin_telegram_id.join(', ');
    } else if (settings.admin_telegram_id !== null && settings.admin_telegram_id !== undefined) {
        settings.admin_telegram_id = String(settings.admin_telegram_id);
    }

    // Auto-réparation légère (évite les valeurs "test" collatérales)
    const repairs = {};
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
        const val = settings[key];
        // On ne répare que SI c'est exactement "test" (pas si ça contient "test" comme "testateur")
        if (typeof val === 'string' && val.toLowerCase() === 'test') {
            settings[key] = SETTINGS_DEFAULTS[key];
            repairs[key] = SETTINGS_DEFAULTS[key];
        }
        // Pour les icônes vide ou non-emoji (fallback securisé)
        if (key.startsWith('ui_icon_') && (!val || val.length > 5 || /^[a-zA-Z0-9]+$/.test(val))) {
            settings[key] = SETTINGS_DEFAULTS[key];
            repairs[key] = SETTINGS_DEFAULTS[key];
        }
    }

    // Synchronisation label_livreur
    if (!settings.label_livreur || settings.label_livreur === '') {
        settings.label_livreur = settings.label_livreur_space || SETTINGS_DEFAULTS.label_livreur;
    }

    if (Object.keys(repairs).length > 0) {
        console.log(`🔧 [DB] Auto-réparation de ${Object.keys(repairs).length} champs :`, Object.keys(repairs).join(', '));
        supabase.from(COL_SETTINGS).update(repairs).eq('id', 'default').then(() => { }, () => { });
    }


    _settingsCache = settings;
    _settingsExpire = Date.now() + 10000; // Cache valid for 10 seconds
    return settings;
}

async function updateAppSettings(settings) {
    // Robustesse: On ne garde que les champs définis dans SETTINGS_DEFAULTS pour éviter les crashs si la table n'est pas à jour
    const filtered = {};
    for (const key in settings) {
        if (Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key) || key === 'id') {
            filtered[key] = settings[key];
        }
    }

    const { error } = await supabase.from(COL_SETTINGS).update(filtered).eq('id', 'default');
    if (error) {
        console.error('❌ Error updating settings:', error);
        throw error;
    }
    _settingsCache = null; // Invalidate cache
}

// --- Products ---
let _productsCache = null;
let _productsExpire = 0;

async function getProducts() {
    if (_productsCache && Date.now() < _productsExpire) {
        return _productsCache;
    }
    const { data } = await supabase.from(COL_PRODUCTS).select('*').order('created_at', { ascending: true });
    _productsCache = data || [];
    _productsExpire = Date.now() + 15000; // Cache valid for 15 seconds
    return _productsCache;
}

async function saveProduct(data) {
    const id = data.id || `${Date.now()}`;
    const createdAt = data.created_at || ts();
    delete data.id;
    delete data.created_at;
    const { error } = await supabase.from(COL_PRODUCTS).upsert({ id, ...data, created_at: createdAt });
    if (error) {
        console.error("Error saveProduct", error);
        throw new Error(`Erreur Supabase: ${error.message}`);
    }
    _productsCache = null; // Invalidate cache
    return id;
}

async function deleteProduct(id) {
    await supabase.from(COL_PRODUCTS).delete().eq('id', id);
    _productsCache = null; // Invalidate cache
}

// --- Broadcasts ---
async function saveBroadcast(data) {
    const id = `${Date.now()}`;
    const now = ts();
    // On s'assure que created_at et start_at sont cohérents pour l'affichage instantané
    const { error } = await supabase.from(COL_BROADCASTS).insert([{
        id,
        ...data,
        created_at: now,
        start_at: data.start_at || now
    }]);

    // Si erreur (probablement colonnes manquantes), on tente de sauver uniquement les colonnes de base
    if (error) {
        console.warn(`[DB-WARN] saveBroadcast fallback: ${error.message}`);
        const filtered = { 
            id, 
            message: data.message, 
            target_platform: data.target_platform, 
            created_at: now, 
            start_at: now,
            poll_data: data.poll_data,
            badge: data.badge,
            media_count: data.media_count,
            total_target: data.total_target,
            status: data.status
        };
        await supabase.from(COL_BROADCASTS).insert([filtered]);
    }
    return id;
}

async function recordPollVote(broadcastId, optionIdx, userId, userName = 'Anonyme') {
    const { data: bc } = await supabase.from(COL_BROADCASTS).select('poll_data').eq('id', broadcastId).single();
    if (!bc) return 'not_found';

    let poll = bc.poll_data || { options: [], title: 'Sondage', votes: {} };
    if (!poll.votes) poll.votes = {};

    // Déjà voté ?
    if (poll.votes[userId]) return 'already_voted';

    poll.votes[userId] = {
        option: optionIdx,
        userName: userName,
        platform: String(userId).startsWith('whatsapp') || String(userId).includes('@') ? 'whatsapp' : 'telegram',
        timestamp: ts()
    };

    // Alerte Admin
    const { notifyAdmins } = require('./notifications');
    const label = poll.options[optionIdx] || `#${optionIdx}`;
    notifyAdmins(null, `🗳 <b>VOTE SONDAGE</b>\n\n👤 Par : <b>${userName}</b>\n🆔 Sondage ID : <code>${broadcastId}</code>\n🔘 Réponse : "<b>${label}</b>"`);

    const { error } = await supabase.from(COL_BROADCASTS).update({ poll_data: poll }).eq('id', broadcastId);
    return error ? 'error' : 'success';
}

async function recordPollFreeResponse(broadcastId, userId, userName, responseText) {
    const { data: bc } = await supabase.from(COL_BROADCASTS).select('poll_data').eq('id', broadcastId).single();
    if (!bc) return 'not_found';

    let poll = bc.poll_data || { options: [], title: 'Sondage', votes: {} };
    if (!poll.free_responses) poll.free_responses = {};
    
    // Déjà répondu ? (libre)
    if (poll.free_responses[userId]) return 'already_voted';

    poll.free_responses[userId] = {
        text: responseText,
        userName: userName,
        platform: String(userId).startsWith('whatsapp') || String(userId).includes('@') ? 'whatsapp' : 'telegram',
        timestamp: ts()
    };

    // Alerte Admin
    const { notifyAdmins } = require('./notifications');
    notifyAdmins(null, `🖋 <b>RÉPONSE LIBRE (SONDAGE)</b>\n\n👤 Par : <b>${userName}</b>\n🆔 Sondage ID : <code>${broadcastId}</code>\n📝 Message : "<i>${responseText}</i>"`);

    const { error } = await supabase.from(COL_BROADCASTS).update({ poll_data: poll }).eq('id', broadcastId);
    return error ? 'error' : 'success';
}

async function updateBroadcast(broadcastId, data) {
    // Liste des colonnes de base garanties (pour le repli si les nouvelles colonnes n'existent pas)
    const baseColumns = ['status', 'success', 'failed', 'blocked', 'completed_at'];

    const { error } = await supabase.from(COL_BROADCASTS).update(data).eq('id', broadcastId);

    // Si erreur (probablement colonnes manquantes), on tente de sauver uniquement les colonnes de base
    if (error) {
        console.warn(`[DB-WARN] updateBroadcast fallack: ${error.message}`);
        const filtered = {};
        for (const key of baseColumns) {
            if (data[key] !== undefined) filtered[key] = data[key];
        }
        await supabase.from(COL_BROADCASTS).update(filtered).eq('id', broadcastId);
    }
}
async function deleteBroadcast(id) {
    await supabase.from(COL_BROADCASTS).delete().eq('id', id);
}

async function getBroadcastHistory(limit = 50, onlyActive = false) {
    let query = supabase.from(COL_BROADCASTS).select('*').order('created_at', { ascending: false });

    if (onlyActive) {
        const now = new Date().toISOString();
        query = query.or(`end_at.is.null,end_at.gt.${now}`).lte('start_at', now);
    }

    const { data } = await query.limit(limit);
    return data || [];
}

async function nukeDatabase() {
    const collections = [COL_REVIEWS, COL_PRODUCTS, COL_ORDERS, COL_USERS, COL_STATS, COL_BROADCASTS, COL_DAILY_STATS, COL_REFERRALS, COL_SETTINGS];
    for (const col of collections) {
        await supabase.from(col).delete().neq('id', 'neverMatchThisString12345'); // Deletes all rows where ID != "..."
    }
}

// --- Reviews ---
async function saveReview(reviewData) {
    const id = reviewData.id || `rev_${Date.now()}`;
    const { error } = await supabase.from(COL_REVIEWS).upsert([{ id, ...reviewData, created_at: ts() }]);
    if (error) throw error;
    return id;
}

async function getReviews(limit = 50) {
    const { data } = await supabase.from(COL_REVIEWS).select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
}

async function getPublicReviews(limit = 20) {
    const { data } = await supabase.from(COL_REVIEWS).select('*').eq('is_public', true).order('created_at', { ascending: false }).limit(limit);
    return data || [];
}

async function deleteReview(id) {
    await supabase.from(COL_REVIEWS).delete().eq('id', id);
}

async function uploadMediaFromUrl(url, fileName) {
    if (!url) return null;
    try {
        const axios = require('axios');
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });

        const buffer = Buffer.from(response.data);
        return uploadMediaBuffer(buffer, fileName, response.headers['content-type'] || 'image/jpeg');
    } catch (e) {
        console.error("❌ uploadMediaFromUrl failed:", e.message);
        throw e;
    }
}

async function uploadMediaBuffer(buffer, fileName, contentType = 'image/jpeg') {
    if (!buffer) return null;
    try {
        const { error } = await supabase.storage.from('uploads').upload(fileName, buffer, {
            contentType,
            upsert: true
        });

        if (error) throw error;
        const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
        return publicUrlData.publicUrl;
    } catch (e) {
        console.error("❌ uploadMediaBuffer failed:", e.message);
        throw e;
    }
}

async function markUserUnblocked(userId) {
    await supabase.from(COL_USERS).update({ is_blocked: false }).eq('id', userId);
}

async function deleteOrder(id) {
    await supabase.from(COL_ORDERS).delete().eq('id', id);
}

module.exports = {
    supabase, COL_USERS, COL_PRODUCTS, COL_ORDERS, COL_SETTINGS, COL_BROADCASTS, COL_REFERRALS,
    incr, ts, makeDocId, decryptUser,
    registerUser, getAllActiveUsers, getAllUsersForBroadcast, markUserBlocked, markUserUnblocked, deleteUser, getUser, updateUserWallet, updateUserPoints,
    getUserCount, getActiveUserCount, getRecentUsers, searchUsers, searchLivreurs,
    generateReferralCode, getReferralLeaderboard, incrementOrderCount,
    setLivreurStatus, updateLivreurPosition, getActiveLivreursCount,
    createOrder, updateOrderStatus, assignOrderLivreur, getOrder, deleteOrder, getAvailableOrders, getAllOrders,
    saveBroadcast, updateBroadcast, deleteBroadcast, getBroadcastHistory, recordPollVote, recordPollFreeResponse, incrementStat, incrementDailyStat,
    getGlobalStats, getDailyStats, getStatsOverview, getAppSettings, updateAppSettings, getClientActiveOrders,
    getProducts, saveProduct, deleteProduct, setLivreurAvailability,
    getAvailableLivreurs, getAllLivreurs, getOrderAnalytics, saveUserLocation, addMessageToTrack, getLastMenuId, getLivreurOrders, getLivreurHistory, getOrdersByUser, getDetailedLivreurActivity, saveFeedback, setPendingFeedback, getAndClearPendingFeedback, nukeDatabase,
    saveReview, getReviews, getPublicReviews, deleteReview, uploadMediaFromUrl,
    incrementChatCount, saveClientReply, logHelpRequest,
    getUpcomingPlannedOrders, markNotifSent, registerUser, addToStat,
    _userCache
};
