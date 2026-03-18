const { getLastMenuId, getTrackedMessages, addMessageToTrack, getUser } = require('./database');
const path = require('path');
const fs = require('fs');

/**
 * L'Unique porte de sortie pour les menus du bot.
 * Garantit qu'un seul message de menu existe à la fois (Flux Constant).
 *
 * LOGIQUE CLÉ:
 * - On ÉDITE toujours le message actuel (pas de delete+send).
 * - Si l'edit est impossible (changement media<->texte), on envoie un nouveau
 *   et on supprime UNIQUEMENT l'ancien message du menu (pas tout le chat).
 * - tracked_messages contient les IDs des messages intermédiaires à nettoyer.
 *
 * PERFORMANCE:
 * - Le cleanup se fait en arrière-plan (non bloquant).
 * - Cache mémoire local pour éviter les appels DB sur chaque navigation.
 */

// Cache mémoire local des messages trackés (évite un aller-retour DB à chaque navigation)
const _trackedCache = new Map(); // userId → [messageId, ...]

// Media group actif : protège ces messages du cleanup tant qu'on reste dans le produit
const _activeMediaGroup = new Map(); // userId → [messageId, ...]

function setActiveMediaGroup(userId, msgIds) {
    _activeMediaGroup.set(userId, msgIds);
}

function clearActiveMediaGroup(userId) {
    _activeMediaGroup.delete(userId);
}

function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function safeEdit(ctx, text, opts = {}) {
    const isGroup = ctx.chat?.type !== 'private';
    const userId = isGroup ? `${ctx.platform}_${ctx.chat.id}` : `${ctx.platform}_${ctx.from.id}`;
    const chatId = ctx.chat?.id;

    if (!chatId) {
        console.error('[SAFE-EDIT] No chat ID available');
        return;
    }

    // 1. Médias & Clavier
    let photo = opts.photo || null;
    if (photo === '') photo = null;

    let isDetectedVideo = false;

    // Résolution Photo
    if (photo) {
        const settings = ctx.state?.settings || {};
        const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');

        if (Array.isArray(photo)) {
            if (photo.length > 0) {
                const p0 = photo[0];
                if (p0.type === 'video') isDetectedVideo = true;
                photo = typeof p0 === 'string' ? p0 : (p0.url || p0.path || '');
            } else photo = null;
        }

        if (photo && typeof photo === 'string') {
            const cp = photo.trim();
            if (cp.startsWith('[') && cp.endsWith(']')) {
                try {
                    const arr = JSON.parse(cp);
                    if (arr && arr.length > 0) {
                        const p0 = arr[0];
                        if (p0.type === 'video') isDetectedVideo = true;
                        photo = typeof p0 === 'string' ? p0 : (p0.url || p0.path || '');
                    } else photo = null;
                } catch (e) {
                    photo = cp.replace(/[\[\]"']/g, '').split(',')[0].trim();
                }
            } else if (cp.includes(',') && !cp.startsWith('http')) {
                photo = cp.split(',')[0].trim();
            } else photo = cp;
        }

        const isFileId = photo && typeof photo === 'string' && !photo.includes('/') && !photo.includes('.');

        if (photo && typeof photo === 'string' && !photo.startsWith('http') && !photo.startsWith('data:') && !isFileId) {
            const relativePath = photo.startsWith('/public/') ? photo.replace('/public/', 'web/public/') : photo;
            const absolutePath = path.resolve(process.cwd(), relativePath.startsWith('/') ? relativePath.substring(1) : relativePath);

            if (fs.existsSync(absolutePath)) {
                photo = absolutePath;
            } else {
                const settings = ctx.state?.settings || {};
                const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');
                photo = baseUrl + (photo.startsWith('/') ? '' : '/') + photo;
            }
        }

        const videoExtRegex = /\.(mp4|mov|avi|mkv|webm|m4v)(\?.*)?$/i;
        if (isDetectedVideo || (photo && typeof photo === 'string' && videoExtRegex.test(photo))) {
            if (!opts.video) opts.video = photo;
            photo = null;
        }
    }

    let video = opts.video || null;
    if (video === '') video = null;
    if (video && typeof video === 'string' && !video.startsWith('http') && !video.startsWith('data:')) {
         const settings = ctx.state?.settings || {};
         const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');
         if (!video.includes('/') && !video.includes('.')) { /* file_id */ }
         else {
             const relativePath = video.startsWith('/public/') ? video.replace('/public/', 'web/public/') : video;
             const absolutePath = path.resolve(process.cwd(), relativePath.startsWith('/') ? relativePath.substring(1) : relativePath);

             if (fs.existsSync(absolutePath)) {
                 video = absolutePath;
             } else {
                 video = baseUrl + (video.startsWith('/') ? '' : '/') + video;
             }
         }
    }

    let reply_markup = opts.reply_markup || (opts.inline_keyboard ? opts : (Array.isArray(opts) ? { inline_keyboard: opts } : null));
    if (reply_markup && reply_markup.reply_markup) reply_markup = reply_markup.reply_markup;
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup };

    const currentMsg = ctx.callbackQuery?.message;

    // Fonction pour supprimer UN SEUL message
    const deleteSingleMessage = async (messageId) => {
        if (!messageId) return;
        try {
            if (ctx.platform === 'telegram' && ctx.telegram) {
                await ctx.telegram.deleteMessage(chatId, messageId).catch(() => { });
            } else if (ctx.platform === 'whatsapp' && ctx.channel) {
                await ctx.channel.deleteMessage(chatId, messageId).catch(() => { });
            }
        } catch (e) { }
    };

    // Helper: supprimer tous les messages trackés sauf le message actif — EN ARRIÈRE-PLAN
    // Protège les messages du media group actif (ils restent tant qu'on est dans le produit)
    const cleanupOrphans = (keepId) => {
        // Non bloquant : on lance le cleanup sans attendre
        (async () => {
            try {
                // D'abord le cache local, puis fallback DB
                let tracked = _trackedCache.get(userId) || [];
                if (tracked.length === 0) {
                    tracked = await getTrackedMessages(userId).catch(() => []);
                }
                // IDs protégés : media group actif + message actuel
                const protectedIds = new Set([String(keepId)]);
                const mgIds = _activeMediaGroup.get(userId) || [];
                mgIds.forEach(id => protectedIds.add(String(id)));

                const toDelete = tracked.filter(id => !protectedIds.has(String(id)));
                if (toDelete.length > 0) {
                    console.log(`[CLEANUP] User ${userId}: suppression ${toDelete.length} msg (protégés: ${protectedIds.size})`);
                    const results = await Promise.allSettled(toDelete.map(id => deleteSingleMessage(id)));
                    results.forEach((r, i) => {
                        if (r.status === 'rejected') console.warn(`[CLEANUP] Échec suppression msg ${toDelete[i]}: ${r.reason}`);
                    });
                }
                // Mettre à jour le cache : garder les protégés
                _trackedCache.set(userId, [...protectedIds].map(Number).filter(Boolean));
            } catch (e) {
                console.error(`[CLEANUP] Erreur: ${e.message}`);
            }
        })();
    };

    try {
        // ═══════════════════════════════════════════════════
        // A. TENTATIVE D'EDIT — C'est la méthode PRIORITAIRE
        // ═══════════════════════════════════════════════════
        if (currentMsg && ctx.telegram) {
            const currentMsgId = currentMsg.message_id;
            const isMediaMsg = !!(currentMsg.photo || currentMsg.video);
            const wantMedia = !!(photo || video);

            // CAS 1 : Même type (texte→texte ou media→media) → EDIT direct
            if (isMediaMsg === wantMedia) {
                try {
                    if (!wantMedia) {
                        await ctx.telegram.editMessageText(chatId, currentMsgId, null, text, extra);
                    } else {
                        await ctx.telegram.editMessageMedia(chatId, currentMsgId, null, {
                            type: photo ? 'photo' : 'video',
                            media: photo || video,
                            caption: text,
                            parse_mode: 'HTML'
                        }, { reply_markup });
                    }
                    // Edit réussi → tracker ce message + nettoyer les orphelins en arrière-plan
                    addMessageToTrack(userId, currentMsgId).catch(() => { });
                    cleanupOrphans(currentMsgId);
                    return;
                } catch (e) {
                    if (String(e.description || '').includes('not modified')) return;
                    // Si l'erreur est liée au média (URL invalide, 0 bytes, etc.), fallback texte pur
                    const errMsg = String(e.description || e.message || '');
                    if (errMsg.includes('wrong type') || errMsg.includes('wrong file') || errMsg.includes('WEBPAGE_MEDIA_EMPTY') || errMsg.includes('failed to get HTTP URL content')) {
                        console.warn('[SAFE-EDIT] Media URL invalide, fallback texte pur:', errMsg);
                        photo = null; video = null;
                        // On est dans un message media, on ne peut pas edit en texte → delete + send texte
                    } else {
                        console.warn('[SAFE-EDIT] Edit failed, fallback to send:', e.message);
                    }
                }
            }

            // CAS 2 : Type différent (texte→media ou media→texte) → Delete ancien + Send nouveau
            let newMsg;
            try {
                if (photo || video) {
                    if (photo) newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
                    else newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
                    // Le Dispatcher retourne { success: false } au lieu de throw — détecter ça
                    if (newMsg && newMsg.success === false && !newMsg.message_id && !newMsg.messageId) {
                        console.warn(`[SAFE-EDIT] Media retourné success:false, fallback texte`);
                        photo = null; video = null;
                        newMsg = await ctx.replyWithHTML(text, extra);
                    }
                } else {
                    newMsg = await ctx.replyWithHTML(text, extra);
                }
            } catch (err) {
                console.error(`[SAFE-EDIT] Send media failed (photo=${photo ? 'yes' : 'no'}, video=${video ? 'yes' : 'no'}):`, err.message);
                // Fallback texte pur — le produit s'affiche quand même sans image
                photo = null; video = null;
                newMsg = await ctx.replyWithHTML(text, extra);
            }

            const newMsgId = newMsg?.message_id || newMsg?.messageId;
            if (newMsgId) {
                // Supprimer l'ancien message du callback immédiatement
                deleteSingleMessage(currentMsgId);
                // Nettoyer les orphelins en arrière-plan
                cleanupOrphans(newMsgId);
                // Tracker le nouveau comme seul message actif
                addMessageToTrack(userId, newMsgId).catch(() => { });
            }
            return;
        }

        // ═══════════════════════════════════════════════════
        // B. PAS DE CALLBACK (premier envoi, ou WhatsApp)
        //    → Send nouveau + supprimer l'ancien menu
        // ═══════════════════════════════════════════════════
        let newMsg;
        if (photo || video) {
            try {
                if (photo) newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
                else newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
                if (newMsg && !newMsg.message_id && !newMsg.messageId && newMsg.success === false) {
                    newMsg = await ctx.replyWithHTML(text, extra);
                }
            } catch (err) {
                console.error(`[SAFE-EDIT] Media failed (photo=${photo ? 'yes' : 'no'}, video=${video ? 'yes' : 'no'}):`, err.message);
                // Fallback texte pur
                photo = null; video = null;
                newMsg = await ctx.replyWithHTML(text, extra);
            }
        } else {
            newMsg = await ctx.replyWithHTML(text, extra);
        }

        if (newMsg) {
            const newMsgId = newMsg.message_id || newMsg.messageId;
            if (newMsgId) {
                // Nettoyer les orphelins en arrière-plan (inclut l'ancien menu)
                cleanupOrphans(newMsgId);
                // Tracker le nouveau
                addMessageToTrack(userId, newMsgId).catch(() => { });
            }
        }

    } catch (e) {
        console.error('❌ safeEdit Fatal:', e.message, e.stack?.split('\n').slice(0,3).join(' | '));
        try {
            const fb = await ctx.replyWithHTML(text, extra);
            if (fb) {
                const fbId = fb.message_id || fb.messageId;
                if (fbId) addMessageToTrack(userId, fbId).catch(() => { });
            }
        } catch (err) { }
    }
}

// Permet à d'autres modules de tracker un message intermédiaire dans le cache local
function trackIntermediateMessage(userId, messageId) {
    const existing = _trackedCache.get(userId) || [];
    if (!existing.includes(messageId)) {
        existing.push(messageId);
        // Max 10 messages
        if (existing.length > 10) existing.shift();
        _trackedCache.set(userId, existing);
    }
}

function debugLog(msg) {
    const fs = require('fs');
    const path = require('path');
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(path.join(process.cwd(), 'debug_timlemeilleur.log'), line);
    } catch (e) { }
    console.log(msg);
}

module.exports = { safeEdit, debugLog, esc, trackIntermediateMessage, setActiveMediaGroup, clearActiveMediaGroup };
