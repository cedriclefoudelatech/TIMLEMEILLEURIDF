const { getLastMenuId, addMessageToTrack, getUser } = require('./database');
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
 * - tracked_messages ne contient que l'ID du message actif du menu.
 */
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

    // Fonction pour supprimer UN SEUL message (l'ancien menu)
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

    // Helper: supprimer les messages orphelins (broadcast, ancien menu, etc.)
    const cleanupOrphans = async (keepId) => {
        try {
            const oldMenuId = await getLastMenuId(userId).catch(() => null);
            if (oldMenuId && String(oldMenuId) !== String(keepId)) {
                deleteSingleMessage(oldMenuId);
            }
        } catch (e) { }
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
                    // Edit réussi → tracker ce message + supprimer les orphelins
                    await addMessageToTrack(userId, currentMsgId).catch(() => { });
                    // Supprimer les vieux messages orphelins (ex: broadcast "catalogue à jour")
                    cleanupOrphans(currentMsgId);
                    return;
                } catch (e) {
                    if (String(e.description || '').includes('not modified')) return;
                    console.warn('[SAFE-EDIT] Edit failed, fallback to send:', e.message);
                }
            }

            // CAS 2 : Type différent (texte→media ou media→texte) → Delete ancien + Send nouveau
            let newMsg;
            try {
                if (photo || video) {
                    if (photo) newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
                    else newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
                } else {
                    newMsg = await ctx.replyWithHTML(text, extra);
                }
            } catch (err) {
                console.error('[SAFE-EDIT] Send failed:', err.message);
                newMsg = await ctx.replyWithHTML(text, extra);
            }

            const newMsgId = newMsg?.message_id || newMsg?.messageId;
            if (newMsgId) {
                // Supprimer l'ancien message du callback
                deleteSingleMessage(currentMsgId);
                // Supprimer aussi le dernier menu traqué s'il est différent (ex: broadcast orphelin)
                cleanupOrphans(newMsgId);
                // Tracker le nouveau comme seul message actif
                await addMessageToTrack(userId, newMsgId).catch(() => { });
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
                console.error('[SAFE-EDIT] Media failed:', err.message);
                newMsg = await ctx.replyWithHTML(text, extra);
            }
        } else {
            newMsg = await ctx.replyWithHTML(text, extra);
        }

        if (newMsg) {
            const newMsgId = newMsg.message_id || newMsg.messageId;
            if (newMsgId) {
                // Récupérer l'ancien message du menu pour le supprimer
                const oldMenuId = await getLastMenuId(userId).catch(() => null);
                if (oldMenuId && String(oldMenuId) !== String(newMsgId)) {
                    deleteSingleMessage(oldMenuId);
                }
                // Tracker le nouveau
                await addMessageToTrack(userId, newMsgId).catch(() => { });
            }
        }

    } catch (e) {
        console.error('❌ safeEdit Fatal:', e.message);
        try {
            const fb = await ctx.replyWithHTML(text, extra);
            if (fb) {
                const fbId = fb.message_id || fb.messageId;
                if (fbId) await addMessageToTrack(userId, fbId).catch(() => { });
            }
        } catch (err) { }
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

module.exports = { safeEdit, debugLog, esc };
