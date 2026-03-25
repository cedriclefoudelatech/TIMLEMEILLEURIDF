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
const COL_SUPPLIER_PRODUCTS = 'supplier_marketplace';
const COL_SUPPLIER_ORDERS = 'supplier_market_orders';

function ts() { return new Date().toISOString(); }

// Simple server-side cache to avoid heavy DB scans on every refresh
const _statsCache = {
    overview: null,
    analytics: null,
    ttl: 30000, // 30 seconds
    lastOverview: 0,
    lastAnalytics: 0
};

const DB_TIMEOUT = 10000;

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
function decryptOrder(order) {
    if (!order) return null;
    return {
        ...order,
        address: encryption.decrypt(order.address) || order.address || '',
        first_name: encryption.decrypt(order.first_name) || order.first_name || '',
        username: encryption.decrypt(order.username) || order.username || '',
    };
}

function decryptReview(review) {
    if (!review) return null;
    return {
        ...review,
        text: encryption.decrypt(review.text) || review.text || '',
        first_name: encryption.decrypt(review.first_name) || review.first_name || '',
        username: encryption.decrypt(review.username) || review.username || '',
    };
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
    const settings = await getAppSettings();

    let existing = null;
    if (_userCache.has(docId)) {
        existing = _userCache.get(docId).data;
    } else {
        const { data: existingArray } = await supabase.from(COL_USERS).select('*').eq('id', docId).limit(1);
        existing = existingArray && existingArray.length > 0 ? existingArray[0] : null;
    }

    // Déduplication WhatsApp : chercher le même numéro sous l'autre suffixe (@lid vs @s.whatsapp.net)
    if (!existing && platform === 'whatsapp') {
        const rawId = String(platformUser.id || '');
        const phoneNum = rawId.split('@')[0].split(':')[0];
        if (phoneNum) {
            const altSuffix = rawId.includes('@lid') ? '@s.whatsapp.net' : '@lid';
            const altId = `whatsapp_${phoneNum}${altSuffix}`;
            const { data: altArray } = await supabase.from(COL_USERS).select('*').eq('id', altId).limit(1);
            if (altArray && altArray.length > 0) {
                existing = altArray[0];
                _userCache.set(docId, { data: existing, expire: nowMs + 300000 });
                console.log(`[WA-Dedup] Utilisateur trouvé sous ${altId} pour ${docId} — fusion par numéro`);
            }
        }

        // Fallback par NOM : Regroupement automatique par identité textuelle si l'ID a changé
        if (!existing && platformUser.first_name && platformUser.first_name !== 'Utilisateur WhatsApp') {
            const encryptedName = encryption.encrypt(platformUser.first_name);
            const { data: nameMatches } = await supabase.from(COL_USERS)
                .select('*')
                .eq('platform', 'whatsapp')
                .eq('first_name', encryptedName)
                .neq('id', docId);

            if (nameMatches && nameMatches.length > 0) {
                // On prend le plus actif (plus de commandes) ou le plus ancien
                existing = nameMatches.sort((a, b) => (b.order_count || 0) - (a.order_count || 0) || new Date(a.date_inscription || 0) - new Date(b.date_inscription || 0))[0];
                console.log(`[WA-Identity-Merged] Regroupement de ${docId} sur l'identité existante ${existing.id} (Nom: "${platformUser.first_name}")`);
                _userCache.set(docId, { data: existing, expire: nowMs + 300000 });
            }
        }
    }

    const isGroup = platformUser.type === 'group' || platformUser.type === 'supergroup';

    // Si l'utilisateur existe déjà
    if (existing) {
        // Optimisation : Ne mettre à jour last_active en DB que toutes les 5 minutes
        const lastUpdated = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const needsDbUpdate = (nowMs - lastUpdated) > 300000; // 5 minutes
        const needsTypeHealing = !existing.type;
        const needsReferralCode = !existing.referral_code;
        const needsAutoApproval = existing.is_approved === false && settings?.auto_approve_new !== false;

        if (needsDbUpdate || needsTypeHealing || needsReferralCode || needsAutoApproval) {
            const updateData = {
                last_active: ts(),
                updated_at: ts(),
                is_active: true
            };

            if (needsTypeHealing) updateData.type = isGroup ? 'group' : 'user';
            if (needsReferralCode) {
                updateData.referral_code = generateReferralCode(platform, platformUser.id || Date.now());
            }
            if (needsAutoApproval) {
                updateData.is_approved = true;
                console.log(`[AUTO-APPROVE] User ${docId} auto-approved (was pending)`);
            }

            // Si on a des infos fraîches sur le nom/username
            if (platformUser.username) updateData.username = !isGroup ? encryption.encrypt(platformUser.username) : platformUser.username;
            if (platformUser.first_name) updateData.first_name = !isGroup ? encryption.encrypt(platformUser.first_name) : platformUser.first_name;

            // Update en tâche de fond (background) pour ne pas ralentir le bot
            supabase.from(COL_USERS).update(updateData).eq('id', docId).then(() => { }, () => { });

            const updatedUser = { ...existing, ...updateData };
            _userCache.set(docId, { data: updatedUser, expire: nowMs + 300000 });

            // Si cet utilisateur déjà inscrit clique sur un lien de parrainage et n'a PAS de parrain encore
            if (referrerId && !existing.referred_by) {
                processReferral(docId, referrerId).catch(console.error);
            }

            return { isNew: false, user: decryptUser(updatedUser) };
        }

        // Si l'utilisateur est connu mais clique sur un lien de parrainage et n'a PAS de parrain encore
        if (referrerId && !existing.referred_by) {
            processReferral(docId, referrerId).catch(console.error);
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
        is_approved: (() => {
            const cleanId = String(platformUser.id).match(/\d+/g)?.[0] || '';
            const adminIds = String(settings?.admin_telegram_id || '').match(/\d+/g) || [];
            const envAdmin = String(process.env.ADMIN_TELEGRAM_ID || '').match(/\d+/g)?.[0] || '';
            const isAdm = adminIds.includes(cleanId) || cleanId === envAdmin;
            // Par défaut pour TIM, auto_approve_new est true (désactive la validation manuelle)
            return isAdm || settings?.auto_approve_new !== false; 
        })(),
        is_admin: (() => {
             const cleanId = String(platformUser.id).match(/\d+/g)?.[0] || '';
             const adminIds = String(settings?.admin_telegram_id || '').match(/\d+/g) || [];
             const envAdmin = String(process.env.ADMIN_TELEGRAM_ID || '').match(/\d+/g)?.[0] || '';
             return adminIds.includes(cleanId) || cleanId === envAdmin;
        })(),
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

    // Si nouvel utilisateur parrainé
    if (referrerId) {
        processReferral(docId, referrerId).catch(console.error);
    }

    _userCache.set(docId, { data: newUser, expire: nowMs + 300000 });

    return { isNew: true, user: decryptUser(newUser) };
}

async function approveUser(userId) {
    const { error } = await supabase.from(COL_USERS).update({ is_approved: true, updated_at: ts() }).eq('id', userId);
    if (error) throw error;
    _userCache.delete(userId);
    return true;
}

async function getPendingUsers() {
    const { data } = await supabase.from(COL_USERS)
        .select('*')
        .eq('is_approved', false)
        .eq('is_blocked', false)
        .order('date_inscription', { ascending: false });
    return (data || []).map(decryptUser);
}

async function getPendingUserCount() {
    const { count } = await supabase.from(COL_USERS)
        .select('*', { count: 'exact', head: true })
        .eq('is_approved', false)
        .eq('is_blocked', false);
    return count || 0;
}

/**
 * Traite l'attribution d'un parrainage.
 * @param {string} docId ID de l'utilisateur parrainé
 * @param {string} referralCode Code de parrainage (ex: ref_telegram_123_xyz)
 */
async function processReferral(docId, referralCode) {
    if (!referralCode) return;
    try {
        // Chercher le parrain par son code
        const { data: refDocs } = await supabase.from(COL_USERS).select('*').eq('referral_code', referralCode).limit(1);
        if (refDocs && refDocs.length > 0) {
            const referrerDoc = refDocs[0];
            
            // Empêcher l'auto-parrainage (même ID platform)
            const refPlatformId = String(referralCode).split('_')[2];
            const myPlatformId = String(docId).split('_')[1];
            if (refPlatformId === myPlatformId) return;

            // Déjà parrainé ? (Double check DB)
            const { data: me } = await supabase.from(COL_USERS).select('referred_by').eq('id', docId).single();
            if (me && me.referred_by) return;

            console.log(`[Referral] Attribution : ${docId} est parrainé par ${referrerDoc.id} (code: ${referralCode})`);

            // Mettre à jour le compteur du parrain
            await supabase.from(COL_USERS).update({
                referral_count: (referrerDoc.referral_count || 0) + 1
            }).eq('id', referrerDoc.id);

            // Lier l'utilisateur au parrain
            await supabase.from(COL_USERS).update({
                referred_by: referrerDoc.id
            }).eq('id', docId);

            // Enregistrer dans la table dédiée
            await supabase.from(COL_REFERRALS).insert([{
                id: `${Date.now()}-${Math.round(Math.random() * 1000)}`,
                referrer_id: referrerDoc.id,
                referred_id: docId,
                created_at: ts()
            }]).catch(() => { });

            await incrementStat('total_referrals').catch(() => { });

            // Invalider les caches
            _userCache.delete(referrerDoc.id);
            _userCache.delete(docId);
        } else {
            console.log(`[Referral] Code ${referralCode} non trouvé dans la DB.`);
        }
    } catch (e) {
        console.error("❌ processReferral error:", e.message);
    }
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
    const creditValue = settings.points_credit_value || 10;

    if (points >= threshold) {
        const conversions = Math.floor(points / threshold);
        const pointsToDeduce = conversions * threshold;
        const creditToAdd = conversions * creditValue;

        const user = await getUser(docId);
        if (user) {
            const newPoints = Math.max(0, points - pointsToDeduce);
            const newBalance = (parseFloat(user.wallet_balance) || 0) + creditToAdd;

            await supabase.from(COL_USERS).update({
                points: newPoints,
                wallet_balance: newBalance
            }).eq('id', docId);
            _userCache.delete(docId);

            try {
                const { sendMessageToUser } = require('./notifications');
                if (user) {
                    await sendMessageToUser(docId, `🎊 <b>Conversion Automatique !</b>\n\nVos ${pointsToDeduce} points ont été convertis en <b>${creditToAdd}€</b> de crédit.\nNouveau solde : <b>${newBalance.toFixed(2)}€</b> 🚀`);
                }
            } catch (e) {
                console.error('[LOYALTY-NOTIF] Error:', e.message);
            }
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

async function addMessageToTrack(docId, messageId, isMenuMsg = true) {
    const user = await getUser(docId);
    if (!user) return;

    if (isMenuMsg) {
        // Message de menu actif : on remplace last_menu_id et on garde l'ancien dans tracked_messages
        const existing = Array.isArray(user.tracked_messages) ? user.tracked_messages : [];
        // Garder les messages intermédiaires (non-menu) + ancien menu pour cleanup, max 10
        const updated = [...existing.filter(id => String(id) !== String(messageId)), messageId].slice(-10);
        await supabase.from(COL_USERS).update({
            tracked_messages: updated,
            last_menu_id: messageId
        }).eq('id', docId);
    } else {
        // Message intermédiaire (notification, réponse, etc.) : on l'ajoute à la liste pour cleanup futur
        const existing = Array.isArray(user.tracked_messages) ? user.tracked_messages : [];
        if (existing.includes(messageId)) return; // Déjà tracké
        const updated = [...existing, messageId].slice(-10);
        await supabase.from(COL_USERS).update({
            tracked_messages: updated
        }).eq('id', docId);
    }

    _userCache.delete(docId);
}

async function getLastMenuId(docId) {
    const user = await getUser(docId);
    return user ? user.last_menu_id : null;
}

async function getTrackedMessages(docId) {
    const user = await getUser(docId);
    return user && Array.isArray(user.tracked_messages) ? user.tracked_messages : [];
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

    // Chiffrement des champs sensibles avant stockage en base
    const secureOrderData = { ...orderData };
    if (secureOrderData.address) secureOrderData.address = encryption.encrypt(secureOrderData.address);
    if (secureOrderData.first_name) secureOrderData.first_name = encryption.encrypt(secureOrderData.first_name);
    if (secureOrderData.username) secureOrderData.username = encryption.encrypt(secureOrderData.username);

    const { data, error } = await supabase.from(COL_ORDERS).insert([{
        id: id,
        ...secureOrderData,
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

                if (settings.enable_referral !== false && isFirstOrder && user.referred_by) {
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

                const newOrderCount = (user.order_count || 0) + 1;

                if (settings.enable_fidelity !== false) {
                    await updateUserPoints(user.id, (user.points || 0) + pointsToAdd);
                    
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
                }
                
                await supabase.from(COL_USERS).update({ order_count: newOrderCount }).eq('id', user.id);

                _userCache.delete(user.id);
                extraData.points_awarded = true;
            }
        }
    }
    await supabase.from(COL_ORDERS).update({ status, ...extraData, updated_at: ts() }).eq('id', orderId);

    if (status === 'delivered') {
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

                if (settings.enable_referral !== false && isFirstOrder && user.referred_by) {
                    await updateUserWallet(user.id, (user.wallet_balance || 0) + refBonus);
                    const referrer = await getUser(user.referred_by);
                    if (referrer) {
                        await updateUserWallet(referrer.id, (referrer.wallet_balance || 0) + refBonus);

                        // Notifier le parrain (Multi-plateforme)
                        const { sendMessageToUser } = require('./notifications');
                        const refMsg = `👥 <b>GÉNIAL ! Récompense Parrainage !</b>\n\nVotre ami <b>${user.first_name || 'anonyme'}</b> vient de passer sa première commande.\n\nNous venons de créditer votre portefeuille de <b>+${refBonus.toFixed(2)}€</b>. Partagez encore votre lien ! 🎁`;
                        await sendMessageToUser(referrer.id, refMsg).catch(() => {});
                    }
                }

                const newOrderCount = (user.order_count || 0) + 1;

                if (settings.enable_fidelity !== false) {
                    await updateUserPoints(user.id, (user.points || 0) + pointsToAdd);
                    
                    // --- Système de Bonus Fidélité ---
                    const thresholds = (settings.fidelity_bonus_thresholds || "5,10,15,20").split(',').map(t => parseInt(t.trim())).filter(t => !isNaN(t));
                    const bonusAmount = parseFloat(settings.fidelity_bonus_amount) || 10;

                    if (thresholds.includes(newOrderCount)) {
                        await updateUserWallet(user.id, (parseFloat(user.wallet_balance) || 0) + bonusAmount);

                        // Notifier le client du bonus (Multi-plateforme)
                        const { sendMessageToUser } = require('./notifications');
                        const bonusMsg = `🏮 <b>C'EST VOTRE JOUR DE CHANCE ! Bonus Fidélité !</b>\n\nFélicitations pour votre <b>${newOrderCount}ème</b> commande !\n\nEn récompense, votre portefeuille a été crédité de <b>+${bonusAmount.toFixed(2)}€</b>. Merci de votre fidélité ! ⭐️`;
                        await sendMessageToUser(user.id, bonusMsg).catch(() => {});
                        console.log(`🎁 Bonus fidélité de ${bonusAmount}€ accordé à ${user.id} pour sa ${newOrderCount}ème commande.`);
                    }
                }
                
                await supabase.from(COL_USERS).update({ order_count: newOrderCount }).eq('id', user.id);
                await supabase.from(COL_ORDERS).update({ points_awarded: true }).eq('id', orderId);

                _userCache.delete(user.id);
            }
        }
    }


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
        await notifyAdmins(null, alertMsg);
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
    return (data || []).map(decryptOrder);
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
        const { notifyAdmins } = require('./notifications');
        const alertMsg = `🚚 <b>AFFECTATION</b>\n\n🆔 #<code>${orderId.slice(-5)}</code>\n👤 Livreur : <b>${livreurName}</b>`;
        // On n'attend pas forcément pour ne pas bloquer le livreur
        notifyAdmins(null, alertMsg).catch(e => console.error("❌ notifyAdmins (assign) failed:", e.message));
    } catch (e) {
        console.error("❌ Notification Admin (assign) error:", e.message);
    }
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

    // NOUVEAU: Notifier l'admin pour l'aider
    try {
        const { notifyAdmins } = require('./notifications');
        const alertMsg = `❓ <b>DEMANDE D'AIDE</b>\n\n🆔 Commande : <code>#${orderId.slice(-5)}</code>\n📌 Type : <b>${type}</b>\n💬 Message : ${message}`;
        notifyAdmins(null, alertMsg).catch(() => {});
    } catch (e) {}
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
    return data && data.length > 0 ? decryptOrder(data[0]) : null;
}

async function getAvailableOrders(city = null) {
    let q = supabase.from(COL_ORDERS).select('*').eq('status', 'pending');
    if (city && city !== 'all' && city !== 'non défini') {
        q = q.eq('city', city.toLowerCase());
    }
    const { data } = await q.order('created_at', { ascending: false });
    return (data || []).map(decryptOrder);
}

async function getAllOrders(limit = 1000) {
    // Essai avec JOIN (relation foreign key possiblement définie dans TIM)
    // Fallback automatique si la relation users:user_id n'existe pas
    try {
        const { data, error } = await supabase.from(COL_ORDERS)
            .select(`
                *,
                users:user_id (
                    is_approved
                )
            `)
            .order('created_at', { ascending: false })
            .abortSignal(AbortSignal.timeout(DB_TIMEOUT))
            .limit(limit);
        
        if (error || !data) {
            console.warn(`[DB-Orders] JOIN failed or no data, falling back: ${error?.message || 'No data'}`);
            const { data: rawOrders } = await supabase.from(COL_ORDERS)
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limit);
            
            if (!rawOrders || rawOrders.length === 0) return [];

            // On récupère les approvals manuellement
            const userIds = [...new Set(rawOrders.map(o => o.user_id))];
            const { data: usersData } = await supabase.from(COL_USERS).select('id, is_approved').in('id', userIds);
            const userMap = {};
            if (usersData) usersData.forEach(u => { userMap[u.id] = u.is_approved; });

            return rawOrders.map(o => {
                const decrypted = decryptOrder(o);
                decrypted.is_approved = userMap[o.user_id] !== undefined ? userMap[o.user_id] : true;
                return decrypted;
            });
        }
        
        return data.map(o => {
            const decrypted = decryptOrder(o);
            const u = Array.isArray(o.users) ? o.users[0] : o.users;
            decrypted.is_approved = u ? u.is_approved : true;
            return decrypted;
        });
    } catch (e) {
        console.error('❌ getAllOrders Fatal:', e.message);
        return []; // On retourne vide plutôt que de tout faire planter en admin
    }
}


/**
 * Recherche multicritère pour le dashboard (ID court ou nom produit)
 */
async function searchOrders(query) {
    if (!query) return [];
    try {
        const { data: orders, error } = await supabase.from(COL_ORDERS)
            .select('*')
            .or(`id.ilike.%${query}%,product_name.ilike.%${query}%`)
            .order('created_at', { ascending: false })
            .limit(50);
            
        if (error) throw error;
        if (!orders || orders.length === 0) return [];

        const userIds = [...new Set(orders.map(o => o.user_id))];
        const { data: usersData } = await supabase.from(COL_USERS)
            .select('id, is_approved')
            .in('id', userIds);

        const userMap = {};
        if (usersData) usersData.forEach(u => { userMap[u.id] = u.is_approved; });

        return orders.map(o => {
            const decrypted = decryptOrder(o);
            decrypted.is_approved = userMap[o.user_id] !== undefined ? userMap[o.user_id] : true;
            return decrypted;
        });
    } catch (e) {
        console.error('❌ searchOrders Failed:', e.message);
        throw e;
    }
}


async function getLivreurHistory(livreurId) {
    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .eq('livreur_id', livreurId)
        .eq('status', 'delivered')
        .order('created_at', { ascending: false });
    return (data || []).map(decryptOrder);
}

async function getLivreurOrders(livreurId) {
    const { data } = await supabase.from(COL_ORDERS)
        .select('*')
        .eq('livreur_id', livreurId)
        .eq('status', 'taken');
    return (data || []).map(decryptOrder);
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
async function getRecentUsers(limit = 100) {
    const { data } = await supabase.from(COL_USERS).select('*').eq('is_blocked', false).order('last_active', { ascending: false }).limit(limit);
    const users = (data || []).map(decryptUser);
    
    const seenId = new Set();
    const seenName = new Set();
    const deduped = [];

    for (const u of users) {
        if (u.platform === 'whatsapp') {
            const rawId = String(u.platform_id || '');
            const phoneNum = rawId.split('@')[0].split(':')[0];
            const name = u.first_name || '';

            // 1. Dédup par numéro
            if (phoneNum && seenId.has(phoneNum)) continue;
            
            // 2. Dédup par nom (si pas le nom par défaut)
            if (name && name !== 'Utilisateur WhatsApp' && seenName.has(name)) continue;

            if (phoneNum) seenId.add(phoneNum);
            if (name && name !== 'Utilisateur WhatsApp') seenName.add(name);
        }
        deduped.push(u);
    }
    return deduped.slice(0, limit);
}

async function getBlockedUsers(limit = 1000) {
    const { data } = await supabase.from(COL_USERS).select('*')
        .eq('is_blocked', true)
        .order('updated_at', { ascending: false })
        .limit(limit);
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
    // Reduce batch to 500 for better CPU performance on Railway
    const { data } = await supabase.from(COL_USERS).select('*').order('last_active', { ascending: false }).limit(500);
    const decrypted = (data || []).map(decryptUser);

    if (!query) {
        // Dédup même pour le retour sans query
        const seen = new Set();
        return decrypted.filter(u => {
            if (u.platform === 'whatsapp' && u.first_name && u.first_name !== 'Utilisateur WhatsApp') {
                if (seen.has(u.first_name)) return false;
                seen.add(u.first_name);
            }
            return true;
        }).slice(0, 50);
    }

    const q = query.toLowerCase().replace('@', '');
    const seen = new Set();
    return decrypted.filter(u => {
        const uid = String(u.id || '').toLowerCase();
        const uname = String(u.username || '').toLowerCase();
        const fname = String(u.first_name || '').toLowerCase();
        const pid = String(u.platform_id || '').toLowerCase();

        const match = uid.includes(q) || uname.includes(q) || fname.includes(q) || pid.includes(q);
        if (!match) return false;

        if (u.platform === 'whatsapp' && u.first_name && u.first_name !== 'Utilisateur WhatsApp') {
            if (seen.has(u.first_name)) return false;
            seen.add(u.first_name);
        }
        return true;
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
    const totalBlocked = await supabase.from(COL_USERS).select('*', { count: 'exact', head: true }).eq('is_blocked', true).then(r => r.count || 0);
    const totalTelegram = await getUserCount('telegram');
    const totalWhatsapp = await getUserCount('whatsapp');
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

    // Get CA from Sum of delivered orders (fallback to global stats if too many/error)
    let calculatedCA = 0;
    try {
        const { data: caData, error: caError } = await supabase.from(COL_ORDERS)
            .select('total_price')
            .eq('status', 'delivered')
            .order('created_at', { ascending: false })
            .limit(4000); // 4000 should be enough for a quick snappy sum

        if (!caError && caData) {
            calculatedCA = caData.reduce((acc, curr) => acc + (parseFloat(curr.total_price) || 0), 0);
        }
    } catch (e) {
        console.error('[STATS] CA calculation error:', e.message);
    }

    const totalCA = calculatedCA || parseFloat(stats.total_ca || stats.global?.total_ca || 0);

    // Get total count of all orders separately if needed, or just delivered
    const { count: totalOrdersCount } = await supabase.from(COL_ORDERS).select('*', { count: 'exact', head: true });

    const result = {
        totalUsers: total - totalBlocked,
        totalBlocked: totalBlocked,
        totalUsersTelegram: totalTelegram,
        totalUsersWhatsapp: totalWhatsapp,
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
        avgBasket: 0,
        avgDeliveryTime: 0,
        byPlatform: {
            telegram: { ca: 0, count: 0, avgBasket: 0, products: {} },
            whatsapp: { ca: 0, count: 0, avgBasket: 0, products: {} }
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
            analytics.byPlatform[platform] = { ca: 0, count: 0, avgBasket: 0, products: {} };
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
        const clientName = encryption.decrypt(order.first_name) || encryption.decrypt(order.username) || 'Client Inconnu';
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

        // Finalize averages
        analytics.avgBasket = analytics.totalOrders > 0 ? (analytics.totalCA / analytics.totalOrders) : 0;
        Object.keys(analytics.byPlatform).forEach(p => {
            const plat = analytics.byPlatform[p];
            plat.avgBasket = plat.count > 0 ? (plat.ca / plat.count) : 0;
        });
        analytics.avgDeliveryTime = deliveryCount > 0 ? (totalDeliveryMinutes / deliveryCount) : 0;

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
        // analytics.byProduct[productName].ca += price; // Already added above — do not duplicate

        if (order.created_at) {
            const date = new Date(order.created_at);
            const hour = date.getHours() + 'h';
            analytics.byHour[hour] = (analytics.byHour[hour] || 0) + price;
            if (!analytics.byPlatform[platform].byHour) analytics.byPlatform[platform].byHour = {};
            analytics.byPlatform[platform].byHour[hour] = (analytics.byPlatform[platform].byHour[hour] || 0) + price;

            const day = date.toISOString().split('T')[0];
            analytics.byDay[day] = (analytics.byDay[day] || 0) + price;
            if (!analytics.byPlatform[platform].byDay) analytics.byPlatform[platform].byDay = {};
            analytics.byPlatform[platform].byDay[day] = (analytics.byPlatform[platform].byDay[day] || 0) + price;

            const year = date.getFullYear();
            const oneJan = new Date(year, 0, 1);
            const weekNum = Math.ceil((((date - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
            const weekKey = `${year}-W${weekNum}`;
            analytics.byWeek[weekKey] = (analytics.byWeek[weekKey] || 0) + price;
            if (!analytics.byPlatform[platform].byWeek) analytics.byPlatform[platform].byWeek = {};
            analytics.byPlatform[platform].byWeek[weekKey] = (analytics.byPlatform[platform].byWeek[weekKey] || 0) + price;

            const month = date.toISOString().substring(0, 7);
            analytics.byMonth[month] = (analytics.byMonth[month] || 0) + price;
            if (!analytics.byPlatform[platform].byMonth) analytics.byPlatform[platform].byMonth = {};
            analytics.byPlatform[platform].byMonth[month] = (analytics.byPlatform[platform].byMonth[month] || 0) + price;

            const yr = date.getFullYear().toString();
            analytics.byYear[yr] = (analytics.byYear[yr] || 0) + price;
            if (!analytics.byPlatform[platform].byYear) analytics.byPlatform[platform].byYear = {};
            analytics.byPlatform[platform].byYear[yr] = (analytics.byPlatform[platform].byYear[yr] || 0) + price;
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
            livreur: order.livreur_name || 'N/A',
            platform: platform
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
    bot_name: 'TIM LE MEILLEUR',
    welcome_message: 'Bienvenue chez TIM LE MEILLEUR ! Livraison express.',
    welcome_message_enabled: true,
    admin_password: 'admin',
    admin_telegram_id: '8795825884',
    dashboard_url: process.env.DASHBOARD_URL || '',
    private_contact_url: 'https://t.me/timlemeilleur75',
    private_contact_wa_url: 'https://wa.me/33618875972',
    channel_url: '',
    bot_description: '',
    bot_short_description: '',
    payment_modes: '💵 Espèces',
    maintenance_mode: false,
    maintenance_message: '🔧 <b>Le bot est actuellement en maintenance.</b>\n\nNous revenons bientôt !',
    maintenance_contact: '',
    accent_color: '#4CAF50',
    languages: 'fr',
    payment_modes_config: '[]',
    force_subscribe: false,
    force_subscribe_channel_id: '',
    default_wa_name: 'Utilisateur',
    enable_abandoned_cart_notifications: false,
    msg_abandoned_cart: '',
    msg_welcome_back: '',
    msg_order_notif_livreur: '',
    msg_order_received_admin: '',
    msg_order_confirmed_client: '',
    enable_telegram: true,
    enable_whatsapp: true,
    enable_marketplace: true,
    enable_fidelity: true,
    enable_referral: true,
    enable_help_menu: true,
    
    // UI Labels & Icons
    label_catalog: 'Catalogue',
    ui_icon_catalog: '🛒',
    label_my_orders: 'Mes Commandes',
    ui_icon_orders: '📦',
    label_contact: 'Contact',
    ui_icon_contact: '📱',
    label_profile: 'Profil',
    ui_icon_profile: '👤',
    label_livreur_space: 'Espace Livreur',
    ui_icon_livreur: '🚴',
    label_admin_bot: 'Admin Bot',
    ui_icon_admin: '⚙️',
    label_admin_web: 'Dashboard Web',
    ui_icon_web: '🌐',
    label_channel: 'Canal',
    ui_icon_channel: '📢',
    label_welcome: 'Bienvenue',
    ui_icon_welcome: '👋',
    label_support: 'Aide & Support',
    ui_icon_support: '❓',
    label_reviews: 'Avis',
    ui_icon_leave_review: '⭐️',
    ui_icon_view_reviews: '👥',
    label_users: 'Utilisateurs',
    label_info: 'Informations',
    ui_icon_info: 'ℹ️',
    
    // Statuses
    status_pending_label: 'Attente Validation',
    ui_icon_pending: '⏳',
    status_taken_label: 'En cours de livraison',
    ui_icon_taken: '🚚',
    status_delivered_label: 'Livré ✅',
    ui_icon_success: '✅',
    status_cancelled_label: 'Annulé ❌',
    ui_icon_error: '❌',
    
    // Messages
    msg_auto_timer: '🔥 <b>Le catalogue est à jour !</b>',
    msg_choose_qty: 'Choisissez la quantité souhaitée :',
    msg_search_livreur: '⏳ Recherche d\'un livreur en cours...',
    msg_order_success: '✅ <b>Commande enregistrée !</b>',
    msg_help_intro: 'Besoin d\'aide ? Choisissez une option ci-dessous :',
    msg_status_taken: '🚚 Votre commande est en route !',
    msg_status_delivered: '✅ Livraison confirmée ! Merci pour votre commande.',
    msg_delay_report: '⏳ Un retard est à signaler pour votre commande.',
    msg_arrival_soon: '🛵 Votre livreur arrive bientôt !',
    msg_review_prompt: '⭐ Êtes-vous satisfait de votre commande ?',
    msg_review_thanks: '🙏 Merci pour votre avis !',
    msg_thanks_participation: 'Merci pour votre participation !',
    msg_your_answer: 'Votre réponse',
    
    // Settings Logic
    points_exchange: 100,
    points_ratio: 1,
    ref_bonus: 5,
    points_credit_value: 10,
    fidelity_wallet_max_pct: 50,
    fidelity_min_spend: 50,
    fidelity_bonus_thresholds: '5,10,15,20',
    fidelity_bonus_amount: 10,
    dashboard_title: 'Dashboard',
    show_broadcasts_btn: true,
    show_reviews_btn: true,
    priority_delivery_enabled: false,
    priority_delivery_price: 15,
    auto_approve_new: false, // Par défaut false pour TIM (validation manuelle active comme La Frappe)
    notify_on_approval: false,
    
    // Buttons
    btn_back_menu: '◀️ Retour Menu',
    btn_back_menu_nav: '◀️ Retour Menu',
    btn_cart_resume: '➡️ 🛒 REPRENDRE MON PANIER',
    btn_client_mode: '🛒 Mode Client (commander)',
    btn_back_generic: '◀️ Retour',
    btn_verify_sub: '✅ Vérifier mon abonnement',
    btn_back_to_cart: '◀️ Retour Panier',
    btn_back_to_qty: '◀️ Retour Quantité',
    btn_back_to_address: '◀️ Retour Adresse',
    btn_back_to_options: '◀️ Retour aux options',
    btn_back_quick_menu: '◀️ Menu',
    btn_back_to_livreur_menu: '◀️ Menu Livreur',
    btn_back_main_menu_alt: '◀️ Menu principal',
    btn_cancel: '◀️ Annuler',
    btn_cancel_alt: '❌ Annuler',
    btn_cancel_order: '❌ Annuler la commande',
    btn_cancel_my_order: '❌ Annuler ma commande',
    btn_abandon_delivery: '❌ Abandonner la livraison',
    btn_dont_use_credit: '❌ Non, payer plein tarif',
    btn_send_now: '✅ Envoyer maintenant',
    btn_set_available: '✅ Passer en Disponible',
    btn_leave_review: '⭐️ Laisser un avis',
    btn_view_reviews: '👥 Voir les avis',
    btn_confirm_review: '✅ Confirmer',
    btn_supplier_ready: '✅ Prêt à livrer',
    btn_supplier_my_sales: '📊 Mes ventes',
    btn_supplier_menu: '🏪 Espace Fournisseur',
    btn_supplier_prep_time: '⏱ Temps de préparation',
    
    // Suppliers
    msg_supplier_new_order: '📦 <b>Nouvelle commande !</b>',
    msg_supplier_ready: '✅ Produit prêt pour livraison !'
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
    _settingsExpire = Date.now() + 30000; // Cache valid for 30 seconds
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
        console.error('❌ Error updating settings:', error.message, '— Trying partial save...');
        // Fallback: save only core fields that always exist
        const coreFields = [
            'bot_name', 'welcome_message', 'admin_password', 'admin_telegram_id',
            'dashboard_url', 'payment_modes', 'maintenance_mode', 'maintenance_message',
            'private_contact_url', 'private_contact_wa_url', 'channel_url', 'accent_color', 'bot_description',
            'label_contact', 'label_channel', 'ui_icon_contact', 'ui_icon_channel',
            'dashboard_title', 'label_support', 'ui_icon_support', 'msg_help_intro',
            'label_catalog', 'ui_icon_catalog', 'label_my_orders', 'ui_icon_orders',
            'payment_modes_config', 'msg_order_received_admin', 'msg_order_confirmed_client',
            'force_subscribe', 'force_subscribe_channel_id', 'priority_delivery_enabled', 'priority_delivery_price'
        ];
        const coreFiltered = {};
        for (const key of coreFields) {
            if (filtered[key] !== undefined) coreFiltered[key] = filtered[key];
        }
        const { error: e2 } = await supabase.from(COL_SETTINGS).update(coreFiltered).eq('id', 'default');
        if (e2) {
            throw new Error(`Erreur sauvegarde: ${error.message}`);
        }
        console.warn('⚠️ Partial settings save done. Some columns may need SQL migration.');
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
    _productsExpire = Date.now() + 60000; // Cache valid for 60 seconds
    return _productsCache;
}

async function saveProduct(data) {
    const id = data.id || `${Date.now()}`;
    // Convertir created_at en ISO si c'est un timestamp unix (nombre ou string numérique)
    let createdAt = data.created_at || ts();
    if (typeof createdAt === 'number' || (typeof createdAt === 'string' && /^\d{10,13}$/.test(createdAt))) {
        createdAt = new Date(Number(createdAt)).toISOString();
    }
    delete data.id;
    delete data.created_at;
    // Nettoyer aussi updated_at si présent avec un timestamp unix
    if (data.updated_at && (typeof data.updated_at === 'number' || (typeof data.updated_at === 'string' && /^\d{10,13}$/.test(data.updated_at)))) {
        data.updated_at = new Date(Number(data.updated_at)).toISOString();
    }
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
    await notifyAdmins(null, `🗳 <b>VOTE SONDAGE</b>\n\n👤 Par : <b>${userName}</b>\n🆔 Sondage ID : <code>${broadcastId}</code>\n🔘 Réponse : "<b>${label}</b>"`).catch(() => {});

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
    await notifyAdmins(null, `🖋 <b>RÉPONSE LIBRE (SONDAGE)</b>\n\n👤 Par : <b>${userName}</b>\n🆔 Sondage ID : <code>${broadcastId}</code>\n📝 Message : "<i>${responseText}</i>"`).catch(() => {});

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
    const secureData = {
        ...reviewData,
        text: reviewData.text ? encryption.encrypt(reviewData.text) : reviewData.text,
        first_name: reviewData.first_name ? encryption.encrypt(reviewData.first_name) : reviewData.first_name,
        username: reviewData.username ? encryption.encrypt(reviewData.username) : reviewData.username,
    };
    const { error } = await supabase.from(COL_REVIEWS).upsert([{ id, ...secureData, created_at: ts() }]);
    if (error) throw error;
    return id;
}

async function getReviews(limit = 50) {
    const { data } = await supabase.from(COL_REVIEWS).select('*').order('created_at', { ascending: false }).limit(limit);
    return (data || []).map(decryptReview);
}

async function getPublicReviews(limit = 20) {
    const { data } = await supabase.from(COL_REVIEWS).select('*').eq('is_public', true).order('created_at', { ascending: false }).limit(limit);
    return (data || []).map(decryptReview);
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

// ─────────────────────────────────────────────────────────────────────────────
//  WhatsApp Session Persistence — stocke les credentials Baileys dans bot_state
//  (table existante), ce qui survit aux redéploiements Railway
// ─────────────────────────────────────────────────────────────────────────────
async function useSupabaseAuthState(sessionId) {
    const TABLE = 'bot_state';
    const NAMESPACE = 'wa_session';
    // Dynamic import for ESM-only baileys (Node 22+)
    const baileysMod = await import('@whiskeysockets/baileys');
    const BufferJSON = baileysMod.BufferJSON;
    const initAuthCreds = baileysMod.initAuthCreds;

    // Construit un ID unique pour bot_state : "wa_session::{sessionId}::{key}"
    function makeId(key) {
        return `${NAMESPACE}::${sessionId}::${key}`;
    }

    async function readData(key) {
        try {
            const { data, error } = await supabase
                .from(TABLE)
                .select('value')
                .eq('id', makeId(key))
                .single();
            if (error || !data) return null;
            return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
        } catch (e) {
            return null;
        }
    }

    async function writeData(key, value) {
        try {
            const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
            await supabase.from(TABLE).upsert({
                id: makeId(key),
                namespace: NAMESPACE,
                user_key: key,
                value: serialized,
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });
        } catch (e) {
            console.error(`[WA-DB] writeData error for key ${key}:`, e.message);
        }
    }

    async function removeData(key) {
        try {
            await supabase.from(TABLE).delete().eq('id', makeId(key));
        } catch (e) { }
    }

    async function clearAllData() {
        try {
            // Supprimer toutes les entrées de cette session
            await supabase.from(TABLE).delete()
                .eq('namespace', NAMESPACE)
                .like('id', `${NAMESPACE}::${sessionId}::%`);
            console.log(`[WA-DB] Session ${sessionId} cleared from Supabase`);
        } catch (e) {
            console.error('[WA-DB] clearAllData error:', e.message);
        }
    }

    // Chargement initial des credentials depuis Supabase
    const credsRaw = await readData('creds');
    const creds = credsRaw || initAuthCreds();
    console.log(`[WA-DB] Auth state loaded from Supabase bot_state (session: ${sessionId}, fresh: ${!credsRaw})`);

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        const value = await readData(`${type}-${id}`);
                        if (value !== null && value !== undefined) {
                            data[id] = value;
                        }
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value) {
                                tasks.push(writeData(`${category}-${id}`, value));
                            } else {
                                tasks.push(removeData(`${category}-${id}`));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds),
        clearSession: clearAllData
    };
}

// ====== SUPPLIERS / FOURNISSEURS ======
const COL_SUPPLIERS = 'bot_suppliers';

async function getSuppliers() {
    const { data } = await supabase.from(COL_SUPPLIERS).select('*').order('created_at', { ascending: false });
    return data || [];
}

async function getSupplier(id) {
    const { data } = await supabase.from(COL_SUPPLIERS).select('*').eq('id', id).limit(1);
    return data?.[0] || null;
}

async function getSupplierByTelegramId(telegramId) {
    const { data } = await supabase.from(COL_SUPPLIERS).select('*').eq('telegram_id', String(telegramId)).limit(1);
    return data?.[0] || null;
}

async function saveSupplier(supplier) {
    if (supplier.id) {
        const { data } = await supabase.from(COL_SUPPLIERS).update(supplier).eq('id', supplier.id).select();
        return data?.[0] || supplier;
    } else {
        const { data } = await supabase.from(COL_SUPPLIERS).insert([supplier]).select();
        return data?.[0] || supplier;
    }
}

async function deleteSupplier(id) {
    // Also unlink products
    await supabase.from(COL_PRODUCTS).update({ supplier_id: null }).eq('supplier_id', id);
    await supabase.from(COL_SUPPLIERS).delete().eq('id', id);
}

async function getSupplierProducts(supplierId) {
    const { data } = await supabase.from(COL_PRODUCTS).select('*').eq('supplier_id', supplierId);
    return data || [];
}

async function getSupplierOrders(supplierId, limit = 50) {
    const { data } = await supabase.from(COL_ORDERS).select('*').eq('supplier_id', supplierId).order('created_at', { ascending: false }).limit(limit);
    return (data || []).map(decryptOrder);
}

async function markOrderSupplierNotified(orderId) {
    await supabase.from(COL_ORDERS).update({ supplier_notified: true }).eq('id', orderId);
}

async function markOrderSupplierReady(orderId, prepTime = null) {
    const update = { supplier_ready_at: new Date().toISOString() };
    if (prepTime) update.supplier_prep_time = prepTime;
    await supabase.from(COL_ORDERS).update(update).eq('id', orderId);
}

// ========== MARKETPLACE FOURNISSEURS ==========

// --- Produits marketplace (gérés par les fournisseurs eux-mêmes) ---

async function getMarketplaceProducts(supplierId = null) {
    let query = supabase.from(COL_SUPPLIER_PRODUCTS).select('*').order('created_at', { ascending: false });
    if (supplierId) query = query.eq('supplier_id', supplierId);
    const { data } = await query;
    return data || [];
}

async function getMarketplaceProduct(id) {
    const { data } = await supabase.from(COL_SUPPLIER_PRODUCTS).select('*').eq('id', id).limit(1);
    return data?.[0] || null;
}

async function getAvailableMarketplaceProducts(supplierId = null) {
    let query = supabase.from(COL_SUPPLIER_PRODUCTS).select('*').eq('is_available', true).gt('stock', 0).order('created_at', { ascending: false });
    if (supplierId) query = query.eq('supplier_id', supplierId);
    const { data } = await query;
    return data || [];
}

async function saveMarketplaceProduct(product) {
    if (product.id) {
        product.updated_at = ts();
        const { data } = await supabase.from(COL_SUPPLIER_PRODUCTS).update(product).eq('id', product.id).select();
        return data?.[0] || product;
    } else {
        product.id = `mp_${Date.now()}_${Math.round(Math.random() * 1E6)}`;
        product.created_at = ts();
        product.updated_at = ts();
        if (product.is_available === undefined) product.is_available = true;
        if (product.stock === undefined) product.stock = 0;
        const { data, error } = await supabase.from(COL_SUPPLIER_PRODUCTS).insert([product]).select();
        if (error) { console.error('saveMarketplaceProduct error:', error); throw error; }
        return data?.[0] || product;
    }
}

async function deleteMarketplaceProduct(id) {
    await supabase.from(COL_SUPPLIER_PRODUCTS).delete().eq('id', id);
}

async function updateMarketplaceStock(productId, newStock) {
    const is_available = newStock > 0;
    await supabase.from(COL_SUPPLIER_PRODUCTS).update({ stock: newStock, is_available, updated_at: ts() }).eq('id', productId);
}

// --- Commandes marketplace (admin -> fournisseur) ---

async function createMarketplaceOrder(orderData) {
    const id = `mpo_${Date.now()}_${Math.round(Math.random() * 1E6)}`;
    const order = {
        id,
        supplier_id: orderData.supplier_id,
        admin_id: orderData.admin_id || 'admin',
        products: JSON.stringify(orderData.products), // [{product_id, name, price, qty}]
        total_price: orderData.total_price || 0,
        address: orderData.address || '',
        delivery_type: orderData.delivery_type || 'delivery',
        status: 'pending', // pending -> accepted -> ready -> collected -> cancelled
        notes: orderData.notes || '',
        created_at: ts(),
        updated_at: ts()
    };
    const { data, error } = await supabase.from(COL_SUPPLIER_ORDERS).insert([order]).select();
    if (error) { console.error('createMarketplaceOrder error:', error); throw error; }

    // Décrémenter le stock des produits commandés
    if (Array.isArray(orderData.products)) {
        for (const item of orderData.products) {
            const prod = await getMarketplaceProduct(item.product_id);
            if (prod) {
                const newStock = Math.max(0, (prod.stock || 0) - (item.qty || 1));
                await updateMarketplaceStock(item.product_id, newStock);
            }
        }
    }

    return data?.[0] || order;
}

async function getMarketplaceOrders(supplierId = null, limit = 50) {
    let query = supabase.from(COL_SUPPLIER_ORDERS).select('*').order('created_at', { ascending: false }).limit(limit);
    if (supplierId) query = query.eq('supplier_id', supplierId);
    const { data } = await query;
    return (data || []).map(o => {
        try { o.products = typeof o.products === 'string' ? JSON.parse(o.products) : o.products; } catch(e) {}
        return o;
    });
}

async function getMarketplaceOrder(orderId) {
    const { data } = await supabase.from(COL_SUPPLIER_ORDERS).select('*').eq('id', orderId).limit(1);
    const o = data?.[0] || null;
    if (o) { try { o.products = typeof o.products === 'string' ? JSON.parse(o.products) : o.products; } catch(e) {} }
    return o;
}

async function updateMarketplaceOrderStatus(orderId, status) {
    const validStatuses = ['pending', 'accepted', 'ready', 'collected', 'cancelled'];
    if (!validStatuses.includes(status)) return;
    await supabase.from(COL_SUPPLIER_ORDERS).update({ status, updated_at: ts() }).eq('id', orderId);
}

// ========== FIN MARKETPLACE ==========

module.exports = {
    supabase, COL_USERS, COL_PRODUCTS, COL_ORDERS, COL_SETTINGS, COL_BROADCASTS, COL_REFERRALS,
    incr, ts, makeDocId, decryptUser, decryptOrder, decryptReview,
    registerUser, getAllActiveUsers, getAllUsersForBroadcast, markUserBlocked, markUserUnblocked, deleteUser, getUser, updateUserWallet, updateUserPoints,
    getUserCount, getActiveUserCount, getRecentUsers, getBlockedUsers, searchUsers, searchLivreurs,
    generateReferralCode, getReferralLeaderboard, incrementOrderCount,
    setLivreurStatus, updateLivreurPosition, getActiveLivreursCount,
    createOrder, updateOrderStatus, assignOrderLivreur, getOrder, deleteOrder, getAvailableOrders, getAllOrders,
    saveBroadcast, updateBroadcast, deleteBroadcast, getBroadcastHistory, recordPollVote, recordPollFreeResponse, incrementStat, incrementDailyStat,
    getGlobalStats, getDailyStats, getStatsOverview, getAppSettings, updateAppSettings, getClientActiveOrders,
    getProducts, saveProduct, deleteProduct, setLivreurAvailability,
    getAvailableLivreurs, getAllLivreurs, getOrderAnalytics, saveUserLocation, addMessageToTrack, getLastMenuId, getTrackedMessages, getLivreurOrders, getLivreurHistory, getOrdersByUser, getDetailedLivreurActivity, saveFeedback, setPendingFeedback, getAndClearPendingFeedback, nukeDatabase,
    saveReview, getReviews, getPublicReviews, deleteReview, uploadMediaFromUrl, uploadMediaBuffer,
    incrementChatCount, saveClientReply, logHelpRequest,
    getUpcomingPlannedOrders, markNotifSent, registerUser, addToStat,
    _userCache,
    useSupabaseAuthState,
    // Suppliers
    COL_SUPPLIERS, getSuppliers, getSupplier, getSupplierByTelegramId, saveSupplier, deleteSupplier,
    getSupplierProducts, getSupplierOrders, markOrderSupplierNotified, markOrderSupplierReady,
    // Marketplace
    COL_SUPPLIER_PRODUCTS, COL_SUPPLIER_ORDERS,
    getMarketplaceProducts, getMarketplaceProduct, getAvailableMarketplaceProducts,
    saveMarketplaceProduct, deleteMarketplaceProduct, updateMarketplaceStock,
    createMarketplaceOrder, getMarketplaceOrders, getMarketplaceOrder, updateMarketplaceOrderStatus,
    approveUser, getPendingUsers, getPendingUserCount
};
