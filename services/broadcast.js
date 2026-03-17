const { getAllUsersForBroadcast, saveBroadcast, updateBroadcast, markUserBlocked } = require('./database');
const { registry } = require('../channels/ChannelRegistry');
const fs = require('fs');
const path = require('path');

function ts() { return new Date().toISOString(); }

function debugLog(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(path.join(process.cwd(), 'debug_shop.log'), line);
    } catch (e) { }
    console.log(msg);
}

// Configuration des délais
const MEDIA_BATCH_SIZE = 5;
const TEXT_BATCH_SIZE = 25;
const DELAY_BETWEEN_BATCHES_MS = 1200;

let _bot = null;
function setBroadcastBot(bot) { _bot = bot; }

async function broadcastMessage(platform, message, options = {}) {
    const {
        mediaFiles = [],
        mediaUrls: existingUrls = [],
        start_at = ts(),
        end_at = null,
        badge = null,
        poll_options = null,
        poll_allow_free = false
    } = options;
    debugLog(`[BC-START] Plateforme: ${platform}, Médias: ${mediaFiles.length}, URLs: ${existingUrls.length}, Message: "${(message || '').substring(0, 30)}..."`);

    // Récupérer toutes les cibles (users + groups)
    let bType = null;
    if (platform === 'users') bType = 'user';
    else if (platform === 'groups') bType = 'group';
    else if (platform === 'livreurs') bType = 'livreurs';

    // On récupère TOUTES les cibles sans filtrer par plateforme pour être sûr de n'oublier personne
    // Et si on cible les 'users', on prend tout ce qui n'est pas un groupe (pour inclure les types non définis)
    // NOUVEAU: On utilise getAllUsersForBroadcast pour inclure aussi les utilisateurs bloqués
    const targets = await getAllUsersForBroadcast(null, bType);
    const totalTargets = targets.length;
    debugLog(`[BC-TARGETS] ${totalTargets} cibles trouvées (Argument Platform: ${platform}, InternalType: ${bType}).`);

    // --- NOUVEAU : Vérification de la planification ---
    const now = new Date();
    const startTime = new Date(start_at);
    const isFuture = startTime > now;

    if (totalTargets === 0) {
        return { success: 0, failed: 0, blocked: 0, total: 0 };
    }

    // 1. Upload des nouveaux médias vers Supabase Storage
    const normalizedExistingUrls = existingUrls.map(u => typeof u === 'string' ? { url: u, type: (u.match(/\.(mp4|mov|avi|wmv)$/) ? 'video' : 'photo') } : u);
    const unifiedMediaList = [...normalizedExistingUrls];
    const { uploadMediaBuffer } = require('./database');
    
    for (let f of mediaFiles) {
        try {
            const extension = f.mimetype.includes('video') ? 'mp4' : (f.mimetype.includes('png') ? 'png' : 'jpg');
            const fileName = `bc-${Date.now()}-${Math.round(Math.random() * 1E9)}-${f.name.replace(/[^a-zA-Z0-9.\-_]/g, '')}`;
            const finalPath = fileName.match(/\.[a-zA-Z0-9]+$/) ? fileName : `${fileName}.${extension}`;

            let fileBuffer = f.data;
            if (!fileBuffer && f.tempFilePath) {
                fileBuffer = fs.readFileSync(f.tempFilePath);
            }

            if (!fileBuffer || fileBuffer.length === 0) {
                debugLog(`[BC-UPLOAD-SKIP] Buffer vide pour ${f.name}`);
                continue;
            }

            const publicUrl = await uploadMediaBuffer(fileBuffer, finalPath, f.mimetype);
            if (publicUrl) {
                unifiedMediaList.push({ url: publicUrl, type: f.mimetype.includes('video') ? 'video' : 'photo' });
            } else {
                debugLog(`[BC-UPLOAD-WARN] Pas d'URL retournée pour ${f.name}. Fallback to buffer.`);
                unifiedMediaList.push({ source: fileBuffer, filename: f.name, type: f.mimetype.includes('video') ? 'video' : 'photo' });
            }
        } catch (e) {
            debugLog(`[BC-UPLOAD-ERR] ${e.message}`);
            let fallbackBuffer = f.data;
            try { if (!fallbackBuffer && f.tempFilePath) fallbackBuffer = fs.readFileSync(f.tempFilePath); } catch (err) { }
            unifiedMediaList.push({ source: fallbackBuffer, filename: f.name, type: f.mimetype.includes('video') ? 'video' : 'photo' });
        }
    }

    // 2. Init log en DB
    const mediaUrlsJson = JSON.stringify(unifiedMediaList.filter(m => m.url).map(m => m.url));
    const finalMessageStr = message ? message : `[Médias: ${unifiedMediaList.length}]`;
    const payloadMessage = `${finalMessageStr}|||MEDIA_URLS|||${mediaUrlsJson}`;

    let broadcastId = options.id;
    if (!broadcastId) {
        broadcastId = await saveBroadcast({
            message: payloadMessage,
            media_count: unifiedMediaList.length,
            total_target: totalTargets,
            target_platform: platform,
            status: isFuture ? 'pending' : 'in_progress',
            success: 0, failed: 0, blocked: 0,
            start_at,
            end_at,
            badge,
            poll_data: poll_options ? { options: poll_options.split('|'), title: message, poll_allow_free: options.poll_allow_free || false } : null
        });
    } else {
        // Si on a déjà un ID, on met à jour son statut au lancement réel
        if (!isFuture) {
            await updateBroadcast(broadcastId, { status: 'in_progress' });
        }
    }

    if (isFuture) {
        debugLog(`[BC-SCHEDULED] Diffusion ${broadcastId} planifiée pour ${start_at}.`);
        return { success: 0, failed: 0, blocked: 0, total: totalTargets, scheduled: true, broadcastId };
    }

    let successCount = 0;
    let failedCount = 0;
    let newlyBlockedCount = 0;
    let previouslyBlockedCount = 0;
    const newlyBlockedNames = [];

    const currentBatchSize = unifiedMediaList.length > 0 ? MEDIA_BATCH_SIZE : TEXT_BATCH_SIZE;

    // On sépare ceux déjà bloqués en DB
    const eligibleTargets = [];
    const seenPlatformIds = new Set();
    for (const u of targets) {
        if (u.is_blocked) {
            previouslyBlockedCount++;
        } else {
            // Dédupliquer par platform_id pour éviter les doublons
            const pid = String(u.platform_id || '').replace(/^(telegram_|whatsapp_)/, '');
            if (seenPlatformIds.has(pid)) {
                debugLog(`[BC-DEDUP] Doublon ignoré: ${u.id} (platform_id: ${pid})`);
                continue;
            }
            seenPlatformIds.add(pid);
            eligibleTargets.push(u);
        }
    }

    let targetsToProcess = [...eligibleTargets];

    // Seed Telegram file_ids by sending to the first user synchronously.
    if (unifiedMediaList.length > 0 && targetsToProcess.length > 0) {
        debugLog("[BC-SEED] Initializing file_id caching with first user...");
        let seederSuccess = false;
        while (targetsToProcess.length > 0 && !seederSuccess) {
            const seedUser = targetsToProcess.shift();
            const res = await sendToUser(seedUser, message, unifiedMediaList);
            if (res.success) {
                successCount++;
                seederSuccess = true;
                debugLog("[BC-SEED] Cached Telegram file_ids successfully.");
            } else {
                if (res.blocked) {
                    newlyBlockedCount++;
                    newlyBlockedNames.push(seedUser.first_name || seedUser.platform_id);
                } else failedCount++;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Now loop through remaining targets
    for (let i = 0; i < targetsToProcess.length; i += currentBatchSize) {
        const batch = targetsToProcess.slice(i, i + currentBatchSize);
        debugLog(`[BC-BATCH] Lot ${Math.floor(i / currentBatchSize) + 1} (${batch.length} cibles)`);

        const results = await Promise.allSettled(
            batch.map((user) => sendToUser(user, message, unifiedMediaList, { ...options, broadcastId }))
        );

        for (const [idx, result] of results.entries()) {
            if (result.status === 'fulfilled') {
                const { success, blocked, error } = result.value;
                if (success) {
                    successCount++;
                } else {
                    if (blocked) {
                        newlyBlockedCount++;
                        newlyBlockedNames.push(batch[idx].first_name || batch[idx].platform_id);
                    } else failedCount++;
                    debugLog(`[BC-FAILED] ${batch[idx].platform_id}: ${error}`);
                }
            } else {
                failedCount++;
                debugLog(`[BC-FATAL] ${batch[idx].platform_id}: ${result.reason}`);
            }
        }

        if (i + currentBatchSize < eligibleTargets.length) {
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
        }
    }

    // Finaliser log en DB
    const finalBlockedCount = newlyBlockedCount + previouslyBlockedCount;
    await updateBroadcast(broadcastId, {
        status: 'completed',
        success: successCount,
        failed: failedCount,
        blocked: finalBlockedCount, // Total bloqués (nouveaux + anciens)
        previously_blocked: previouslyBlockedCount,
        blocked_names: newlyBlockedNames.length > 0 ? newlyBlockedNames.join(', ') : null,
        completed_at: ts()
    }).catch(e => debugLog(`[BC-LOG-ERR] ${e.message}`));

    debugLog(`[BC-END] Terminé. Succès: ${successCount}, Échecs: ${failedCount}, Total Bloqués: ${finalBlockedCount} (Nouveaux: ${newlyBlockedCount}, Anciens: ${previouslyBlockedCount})`);
    return { success: successCount, failed: failedCount, blocked: finalBlockedCount, total: totalTargets, broadcastId };
}

async function sendToUser(user, message, unifiedMediaList = [], options = {}) {
    // 1. Déterminer le canal — détecter WhatsApp même si platform est "telegram" en DB
    let platform = user.platform || 'telegram';
    const pid = String(user.platform_id || '');
    
    // Si le platform_id contient @ c'est un ID WhatsApp (ex: 108388298051671@lid)
    if (pid.includes('@')) {
        platform = 'whatsapp';
    }
    
    const channel = registry.query(platform);
    
    // Si c'est WhatsApp (ou autre que Telegram), on utilise l'interface unifiée
    if (platform !== 'telegram') {
        if (!channel || !channel.isActive) {
            debugLog(`[BC-SKIP] Canal ${platform} inactif ou non trouvé pour ${user.platform_id}`);
            return { success: false, error: "Canal inactif" };
        }

        const buttons = options.poll_options ? options.poll_options.split('|').map((opt, idx) => ({
            id: `poll_vote_${options.broadcastId}_${idx}`,
            title: opt
        })) : [];

        // Nettoyer le platform_id (enlever le prefixe telegram_ ou whatsapp_)
        const cleanPid = pid.replace(/^(telegram_|whatsapp_)/, '');

        try {
            if (buttons.length > 0) {
                await channel.sendInteractive(cleanPid, message, buttons, {
                    media_url: unifiedMediaList[0]?.url || null,
                    media_type: unifiedMediaList[0]?.type || 'photo'
                });
            } else {
                // WhatsApp: On envoie chaque média s'il y en a plusieurs
                if (unifiedMediaList.length > 1) {
                    for (let i = 0; i < unifiedMediaList.length; i++) {
                        const m = unifiedMediaList[i];
                        const cap = (i === 0) ? message : ""; // Caption seulement sur le premier
                        await channel.sendMessage(cleanPid, cap, { media_url: m.url, media_type: m.type });
                        await new Promise(r => setTimeout(r, 500));
                    }
                } else {
                    const m = unifiedMediaList[0];
                    await channel.sendMessage(cleanPid, message, { 
                        media_url: m?.url || null, 
                        media_type: m?.type || 'photo' 
                    });
                }
            }
            return { success: true };
        } catch (err) {
            debugLog(`[BC-ERR-WA] ${cleanPid}: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    // 2. Logique spécifique Telegram (existante)
    if (!_bot) {
        debugLog("[BC-ERROR] Bot Telegram non initialisé");
        return { success: false, error: "Bot non prêt" };
    }

    const { Markup } = require('telegraf');
    const poll_options = options.poll_options ? options.poll_options.split('|') : null;
    const poll_allow_free = options.poll_allow_free || false;
    const broadcastId = options.broadcastId;

    let keyboard = null;
    if (poll_options && poll_options.length > 0) {
        const btns = poll_options.map((opt, idx) => [Markup.button.callback(opt, `poll_vote_${broadcastId}_${idx}`)]);
        if (poll_allow_free) {
            btns.push([Markup.button.callback('🖊 Réponse libre', `poll_free_${broadcastId}`)]);
        }
        keyboard = Markup.inlineKeyboard(btns);
    }

    // On nettoie le chatId pour Telegram (retirer le préfixe 'telegram_' si présent)
    const chatId = String(user.platform_id || '').replace('telegram_', '');
    // Captions are limited to 1024 chars in Telegram
    const maxCaption = 1020;
    const caption = message ? (message.length > maxCaption ? message.substring(0, maxCaption - 3) + '...' : message) : '';

    // Helper function for safe send with fallback
    const safeSend = async (method, ...args) => {
        try {
            // First attempt: HTML
            return await _bot.telegram[method](chatId, ...args, { parse_mode: 'HTML' });
        } catch (err) {
            const desc = err.description || '';
            if (desc.includes('can\'t parse entities') || desc.includes('bad request')) {
                debugLog(`[BC-RETRY] Fallback to Plain text for ${chatId} (${method})`);
                // Second attempt: Plain text (no parse_mode)
                return await _bot.telegram[method](chatId, ...args);
            }
            throw err;
        }
    };
    try {
        if (unifiedMediaList.length > 1) {
            const mediaGroup = unifiedMediaList.slice(0, 10).map((m, i) => {
                let mediaObj = m.file_id;
                if (!mediaObj) {
                    if (m.source) {
                        mediaObj = { source: m.source, filename: m.filename || 'media.mp4' };
                    } else if (m.url) {
                        mediaObj = m.url;
                    }
                }
                return {
                    type: m.type,
                    media: mediaObj,
                    ...(m.type === 'video' ? { supports_streaming: true } : {}),
                    ...(i === 0 && caption ? { caption: caption } : {})
                };
            });

            debugLog(`[BC-SEND] MediaGroup (${mediaGroup.length}) -> ${chatId}`);
            if (mediaGroup[0] && mediaGroup[0].caption) {
                mediaGroup[0].parse_mode = 'HTML';
            }

            let msgs;
            try {
                msgs = await _bot.telegram.sendMediaGroup(chatId, mediaGroup);
            } catch (err) {
                if (err.description?.includes('can\'t parse entities') && mediaGroup[0]) {
                    delete mediaGroup[0].parse_mode;
                    msgs = await _bot.telegram.sendMediaGroup(chatId, mediaGroup);
                } else throw err;
            }

            // Cache file_ids & Tracking
            if (msgs && Array.isArray(msgs)) {
                const { addMessageToTrack } = require('./database');
                for (const msg of msgs) {
                    await addMessageToTrack(user.id || user.doc_id, msg.message_id).catch(() => { });
                }

                msgs.forEach((msg, i) => {
                    if (!unifiedMediaList[i].file_id) {
                        let fId = null;
                        if (msg.photo && msg.photo.length > 0) fId = msg.photo[msg.photo.length - 1].file_id;
                        else if (msg.video) fId = msg.video.file_id;
                        if (fId) unifiedMediaList[i].file_id = fId;
                    }
                });
            }
        } else if (unifiedMediaList.length === 1) {
            const mData = unifiedMediaList[0];
            let mediaObj = mData.file_id;
            if (!mediaObj) {
                if (mData.source) mediaObj = { source: mData.source, filename: mData.filename || 'media.mp4' };
                else if (mData.url) mediaObj = mData.url;
            }

            debugLog(`[BC-SEND] Single ${mData.type.toUpperCase()} -> ${chatId}`);
            let msg;
            if (mData.type === 'video') {
                msg = await safeSend('sendVideo', mediaObj, { caption: caption, supports_streaming: true, ...(keyboard ? keyboard : {}) });
                if (msg.video && !mData.file_id) mData.file_id = msg.video.file_id;
            } else {
                msg = await safeSend('sendPhoto', mediaObj, { caption: caption, ...(keyboard ? keyboard : {}) });
                if (msg.photo && !mData.file_id) mData.file_id = msg.photo[msg.photo.length - 1].file_id;
            }
            if (msg && (user.id || user.doc_id)) {
                const { addMessageToTrack } = require('./database');
                await addMessageToTrack(user.id || user.doc_id, msg.message_id).catch(() => { });
            }
        } else {
            // Texte uniquement
            debugLog(`[BC-SEND] Texte -> ${chatId}`);
            if (!message || message.trim() === '') {
                debugLog(`[BC-SKIP] Message vide pour ${chatId}`);
                return { success: true }; // On skip les messages vides sans erreur
            }
            try {
                const msg = await _bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML', ...(keyboard ? keyboard : {}) });
                if (msg && (user.id || user.doc_id)) {
                    const { addMessageToTrack } = require('./database');
                    await addMessageToTrack(user.id || user.doc_id, msg.message_id).catch(() => { });
                }
            } catch (err) {
                if (err.description?.includes('can\'t parse entities')) {
                    debugLog(`[BC-RETRY] Plain text fallback for: ${chatId}`);
                    const msg = await _bot.telegram.sendMessage(chatId, message, (keyboard ? keyboard : {}));
                    if (msg && (user.id || user.doc_id)) {
                        const { addMessageToTrack } = require('./database');
                        await addMessageToTrack(user.id || user.doc_id, msg.message_id).catch(() => { });
                    }
                } else throw err;
            }
        }
        return { success: true };
    } catch (error) {
        const desc = (error.description || error.message || "Erreur inconnue").toLowerCase();
        const errorName = error.name || "Error";
        const code = error.code || 0;

        debugLog(`[BC-ERROR] Cible ${chatId}: [${errorName}] ${desc} (Code: ${code})`);

        // Liste exhaustive des erreurs indiquant un blocage ou un bot supprimé
        const isBlockedError = code === 403 ||
            desc.includes('blocked') ||
            desc.includes('chat not found') ||
            desc.includes('kicked') ||
            desc.includes('user is deactivated') ||
            desc.includes('forbidden');

        if (isBlockedError) {
            if (user.id || user.doc_id) {
                const { markUserBlocked } = require('./database');
                await markUserBlocked(user.id || user.doc_id, false).catch(e => {
                    debugLog(`[BC-MARK-ERR] Failed to mark ${chatId} as blocked: ${e.message}`);
                });
            }
            return { success: false, blocked: true, error: desc };
        }
        return { success: false, error: desc };
    }
}

module.exports = { broadcastMessage, setBroadcastBot };
