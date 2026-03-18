const { getLastMenuId, addMessageToTrack, getUser } = require('./database');
const path = require('path');
const fs = require('fs');

/**
 * L'Unique porte de sortie pour les menus du bot.
 * Garantit qu'un seul message de menu existe à la fois (Flux Constant).
 */
function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function safeEdit(ctx, text, opts = {}) {
    const isGroup = ctx.chat.type !== 'private';
    const userId = isGroup ? `${ctx.platform}_${ctx.chat.id}` : `${ctx.platform}_${ctx.from.id}`;
    const chatId = ctx.chat.id;

    // 1. Médias & Clavier
    let photo = opts.photo || null;
    if (photo === '') photo = null;
    console.log('[SAFE-EDIT] Received opts.photo:', opts.photo ? JSON.stringify(opts.photo).substring(0, 120) : null);

    let isDetectedVideo = false;

    // Résolution Photo (Base URL si path relatif + Extraction Liste)
    if (photo) {
        const settings = ctx.state?.settings || {};
        const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');

        // Si c'est un tableau de photos, on prend la première
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

        // Final check: if relative path (not URL, not file_id), add baseUrl
        // On considère que c'est un file_id si ça n'a pas de / ni de .
        const isFileId = photo && typeof photo === 'string' && !photo.includes('/') && !photo.includes('.');

        if (photo && typeof photo === 'string' && !photo.startsWith('http') && !photo.startsWith('data:') && !isFileId) {
            // Résolution chemin local absolu pour upload direct (plus fiable que URL si local)
            const relativePath = photo.startsWith('/public/') ? photo.replace('/public/', 'web/public/') : photo;
            const absolutePath = path.resolve(process.cwd(), relativePath.startsWith('/') ? relativePath.substring(1) : relativePath);
            
            if (fs.existsSync(absolutePath)) {
                console.log('[SAFE-EDIT] Local file detected, using absolute path:', absolutePath);
                photo = absolutePath;
            } else {
                photo = baseUrl + (photo.startsWith('/') ? '' : '/') + photo;
            }
        }

        // Auto-detection: Si l'URL de la photo est en réalité une vidéo
        const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
        if (isDetectedVideo || (photo && typeof photo === 'string' && videoExts.some(ext => photo.toLowerCase().endsWith(ext)))) {
            if (!opts.video) opts.video = photo;
            photo = null;
        }
    }

    let video = opts.video || null;
    if (video === '') video = null;
    if (video && typeof video === 'string' && !video.startsWith('http') && !video.startsWith('data:')) {
         const settings = ctx.state?.settings || {};
         const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');
         if (!video.includes('/') && !video.includes('.')) { /* file_id, do nothing */ }
         else {
             const relativePath = video.startsWith('/public/') ? video.replace('/public/', 'web/public/') : video;
             const absolutePath = path.resolve(process.cwd(), relativePath.startsWith('/') ? relativePath.substring(1) : relativePath);
             
             if (fs.existsSync(absolutePath)) {
                 console.log('[SAFE-EDIT] Local video detected, using absolute path:', absolutePath);
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

    // Fonction de nettoyage asynchrone pour ne pas ralentir le bot
    const runCleanup = async (newId) => {
        try {
            const userObj = await getUser(userId).catch(() => null);
            if (!userObj) return;

            const toDelete = new Set();
            if (currentMsg) toDelete.add(String(currentMsg.message_id || currentMsg.messageId));
            if (userObj.last_menu_id) toDelete.add(String(userObj.last_menu_id));
            if (userObj.tracked_messages) {
                userObj.tracked_messages.forEach(mid => { if (mid) toDelete.add(String(mid)); });
            }
            if (newId) toDelete.delete(String(newId));

            for (const mid of toDelete) {
                if (ctx.platform === 'telegram') {
                    // Telegram: suppression via l'instance Telegraf
                    ctx.telegram.deleteMessage(chatId, mid).catch(() => { });
                } else if (ctx.platform === 'whatsapp') {
                    // WhatsApp: suppression via le canal
                    ctx.channel.deleteMessage(chatId, mid).catch(() => { });
                }
            }
        } catch (e) { }
    };

    try {
        // A. TENTATIVE D'EDIT (Telegram Uniquement)
        if (currentMsg && ctx.telegram) {
            const isMediaMsg = !!(currentMsg.photo || currentMsg.video);
            const wantMedia = !!(photo || video);

            if (isMediaMsg === wantMedia) {
                try {
                    if (!wantMedia) {
                        await ctx.telegram.editMessageText(chatId, currentMsg.message_id, null, text, extra);
                    } else {
                        await ctx.telegram.editMessageMedia(chatId, currentMsg.message_id, null, {
                            type: photo ? 'photo' : 'video',
                            media: photo || video,
                            caption: text,
                            parse_mode: 'HTML'
                        }, { reply_markup });
                    }
                    await addMessageToTrack(userId, currentMsg.message_id).catch(() => { });
                    runCleanup(currentMsg.message_id); // Toujours nettoyer même sur Edit réussi
                    return;
                } catch (e) {
                    if (String(e.description || '').includes('not modified')) return;
                    console.warn('safeEdit: edit failed, fallback to send', e.message);
                }
            }
        }

        // B. ENVOI DU NOUVEAU
        let newMsg;
        if (photo || video) {
            console.log('[SAFE-EDIT] Sending media, photo URL:', photo ? String(photo).substring(0, 80) : null);
            try {
                if (photo) newMsg = await ctx.replyWithPhoto(photo, { caption: text, ...extra });
                else newMsg = await ctx.replyWithVideo(video, { caption: text, ...extra });
                // Si le média a échoué (returned falsy or no messageId) → fallback texte
                if (newMsg && !newMsg.message_id && !newMsg.messageId && newMsg.success === false) {
                    console.warn('[SAFE-EDIT] Media renvoyé mais marqué failed, fallback texte');
                    newMsg = await ctx.replyWithHTML(text, extra);
                }
            } catch (err) {
                console.error('[SAFE-EDIT] Media Send FAILED:', err.message, '| photo was:', photo ? String(photo).substring(0, 100) : null);
                newMsg = await ctx.replyWithHTML(text, extra);
            }
        } else {
            newMsg = await ctx.replyWithHTML(text, extra);
        }

        if (newMsg) {
            // Sur WA message_id est dans res, sur TG c'est direct (messageId depuis sendMessage/sendPhoto)
            const msgId = newMsg.message_id || newMsg.messageId;
            if (msgId) {
                await addMessageToTrack(userId, msgId).catch(() => { });
                runCleanup(msgId);
            } else if (currentMsg && currentMsg.message_id) {
                // Fallback: si pas de messageId retourné mais on a le msg précédent, nettoyer quand même
                runCleanup(null);
            }
        }

    } catch (e) {
        console.error('❌ safeEdit Fatal:', e.message);
        try {
            const fb = await ctx.replyWithHTML(text, extra);
            if (fb) {
                const fbId = fb.message_id || fb.messageId;
                if (fbId) {
                    await addMessageToTrack(userId, fbId).catch(() => { });
                    runCleanup(fbId);
                }
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
