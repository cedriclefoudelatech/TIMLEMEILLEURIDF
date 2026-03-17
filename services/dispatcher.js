const { registry } = require('../channels/ChannelRegistry');
const { registerUser, getAppSettings } = require('./database');
const { createPersistentMap } = require('./persistent_map');

class Dispatcher {
    constructor() {
        this.commands = new Map();
        this.actions = new Map();
        this.middleware = [];
        this.onHandlers = [];
        this.catchHandler = null;
        this.userLastButtons = createPersistentMap('userLastButtons'); 
        this.userLastMessageIds = createPersistentMap('userLastMessageIds');
        this.processedMessages = new Set(); // Pour éviter les doublons de Baileys
    }

    // Normalise les IDs utilisateurs (surtout WhatsApp : retire le suffixe de session :1, :2...)
    _normalizeId(id) {
        if (!id) return id;
        const s = String(id);
        if (s.includes('@s.whatsapp.net')) {
            return s.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        }
        if (s.includes('@lid')) {
            return s.split(':')[0].split('@')[0] + '@lid';
        }
        return s;
    }

    async init() {
        await this.userLastButtons.load();
        await this.userLastMessageIds.load();
    }

    // Permet aux fonctions externes (notifyUser) d'enregistrer des boutons pour le fallback numérique WA
    setLastButtons(userId, buttons) {
        if (buttons && buttons.length > 0) {
            console.log(`[Dispatcher] setLastButtons for ${userId}: ${JSON.stringify(buttons.map(b => b.id || b.title))}`);
            this.userLastButtons.set(userId, buttons);
        }
    }

    // --- Interface pour simuler Telegraf ---
    use(fn) { this.middleware.push(fn); }
    command(cmd, fn) { this.commands.set(cmd, fn); }
    action(trigger, fn) { this.actions.set(trigger, fn); }
    on(type, fn) { this.onHandlers.push({ type, fn }); }
    catch(fn) { this.catchHandler = fn; }

    // --- Gestion des messages entrants ---
    async handleUpdate(channel, msg) {
        // 0. Dé-duplication (Baileys envoie parfois plusieurs fois le même message)
        const msgId = msg.message_id || msg.rawId;
        if (msgId && this.processedMessages.has(msgId)) {
            console.log(`[Dispatcher] Ignored duplicate message: ${msgId}`);
            return;
        }
        if (msgId) {
            this.processedMessages.add(msgId);
            if (this.processedMessages.size > 100) {
                const first = this.processedMessages.values().next().value;
                this.processedMessages.delete(first);
            }
        }

        const fromRaw = String(msg.from || '');
        const fromStr = this._normalizeId(fromRaw);
        console.log(`[Dispatcher] HandleUpdate from ${channel.type}: ${fromStr} (Raw: ${fromRaw})`);
        
        // Auto-enregistrement/mise à jour de l'utilisateur pour ce canal
        try {
            // Pour WhatsApp, on garde le JID complet normalisé
            const userId = channel.type === 'whatsapp' ? fromStr : fromStr.split('@')[0];
            const settings = await getAppSettings();
            
            const { isNew, user: registeredUser } = await registerUser({
                id: userId,
                first_name: msg.name || settings.default_wa_name || 'Utilisateur WhatsApp',
                username: '',
                type: 'user'
            }, channel.type);

            msg.user = registeredUser;
            msg._isNewUser = isNew;
        } catch (e) {
            console.error(`[Dispatcher] Auto-reg failed:`, e.message);
        }

        // Uniformisation du contexte
        const ctx = await this._createUnifiedContext(channel, msg, fromStr);
        
        try {
            // 1. Exécuter les middlewares
            let index = -1;
            const next = async () => {
                index++;
                if (index < this.middleware.length) {
                    await this.middleware[index](ctx, next);
                } else {
                    await this._route(ctx);
                }
            };
            await next();
        } catch (err) {
            console.error(`[Dispatcher] Error:`, err);
            if (this.catchHandler) await this.catchHandler(err, ctx);
        }
    }

    async _createUnifiedContext(channel, msg, normalizedFrom) {
        const userId = normalizedFrom || this._normalizeId(msg.from);
        const settings = await getAppSettings();
        
        const ctx = {
            channel: channel,
            platform: channel.type, // 'telegram' ou 'whatsapp'
            from: { id: userId, first_name: msg.name, is_bot: false },
            chat: { id: userId, type: 'private' },
            state: { user: msg.user, settings: settings },
            _handled: false,
            message: { text: msg.text, photo: msg.photo, message_id: msg.message_id || msg.rawId },
            updateType: msg.type || 'message',
            match: null,
            botInfo: { username: settings.bot_name || 'Bot' },
            callbackQuery: msg.isAction ? { 
                data: msg.text,
                message: msg.ctx?.callbackQuery?.message || null
            } : null,
            telegram: {
                // Si on a l'instance réelle (Telegram), on l'expose au cas où
                instance: (channel.type === 'telegram' && channel.getBotInstance) ? channel.getBotInstance().telegram : null,
                
                sendMessage: async (id, text, extra = {}) => {
                    const { sendMessageToUser } = require('./notifications');
                    if (String(id) === String(userId)) return ctx.reply(text, extra);
                    return sendMessageToUser(id, text, extra);
                },
                sendPhoto: async (id, photo, extra = {}) => {
                    const { sendMessageToUser } = require('./notifications');
                    if (String(id) === String(userId)) return ctx.replyWithPhoto(photo, extra);
                    return sendMessageToUser(id, extra.caption || "", { ...extra, media_url: photo, media_type: 'photo' });
                },
                sendVideo: async (id, video, extra = {}) => {
                    const { sendMessageToUser } = require('./notifications');
                    if (String(id) === String(userId)) return ctx.replyWithVideo(video, extra);
                    return sendMessageToUser(id, extra.caption || "", { ...extra, media_url: video, media_type: 'video' });
                },
                editMessageText: async (cid, mid, mid2, text, extra = {}) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.editMessageText(cid || userId, mid, mid2, text, { parse_mode: 'HTML', ...extra });
                    }
                    return ctx.reply(text, extra);
                },
                editMessageMedia: async (cid, mid, mid2, media, extra = {}) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.editMessageMedia(cid || userId, mid, mid2, media, extra);
                    }
                    return ctx.replyWithPhoto(media.media, { caption: media.caption });
                },
                deleteMessage: async (cid, mid) => {
                    if (channel.type === 'telegram') {
                        const tgCh = registry.query('telegram');
                        const tgBot = tgCh?.getBotInstance?.();
                        if (tgBot) return tgBot.telegram.deleteMessage(cid || userId, mid).catch(() => {});
                    }
                    return channel.deleteMessage(cid || userId, mid);
                },
                setChatMenuButton: async () => {}
            },

            reply: async (text, extra = {}) => {
                ctx._handled = true;
                const options = this._convertExtra(extra);
                if (options.buttons) this.userLastButtons.set(userId, options.buttons);
                
                // Cleanup auto pour WA
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    console.log(`[WA-Cleanup] Tentative de suppression de ${oldIds.length} messages pour ${userId}`);
                    for(const id of oldIds) {
                        try {
                            await channel.deleteMessage(userId, id);
                        } catch (e) {
                            console.warn(`[WA-Cleanup] Echec suppression ${id}:`, e.message);
                        }
                    }
                    this.userLastMessageIds.delete(userId);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, text, options.buttons, options);
                } else {
                    res = await channel.sendMessage(userId, text, options);
                }
                
                if (channel.type === 'whatsapp') {
                    if (!res) {
                        console.error(`[WA-Reply] sendInteractive/sendMessage a retourné undefined pour ${userId} — socket probablement déconnecté.`);
                        return { success: false };
                    }
                    const sentIds = res.sentIds || (res.messageId ? [res.messageId] : []);
                    if (sentIds.length > 0) {
                        this.userLastMessageIds.set(userId, sentIds);
                        console.log(`[WA-Stored] IDs stockés pour ${userId}:`, sentIds);
                    }
                }
                return res;
            },
            replyWithHTML: async (text, extra = {}) => ctx.reply(text, { ...extra, parse_mode: 'HTML' }),
            replyWithPhoto: async (photo, extra = {}) => {
                ctx._handled = true;
                const options = this._convertExtra(extra);
                if (options.buttons) this.userLastButtons.set(userId, options.buttons);
                
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    for(const id of oldIds) await channel.deleteMessage(userId, id);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, extra.caption || "", options.buttons, { ...options, media_url: photo, media_type: 'photo' });
                } else {
                    res = await channel.sendMessage(userId, extra.caption || "", { ...options, media_url: photo, media_type: 'photo' });
                }

                if (channel.type === 'whatsapp' && res.sentIds) this.userLastMessageIds.set(userId, res.sentIds);
                else if (channel.type === 'whatsapp' && res.messageId) this.userLastMessageIds.set(userId, [res.messageId]);
                return res;
            },
            replyWithVideo: async (video, extra = {}) => {
                ctx._handled = true;
                const options = this._convertExtra(extra);
                if (options.buttons) this.userLastButtons.set(userId, options.buttons);
                
                if (channel.type === 'whatsapp') {
                    const oldIds = this.userLastMessageIds.get(userId) || [];
                    for(const id of oldIds) await channel.deleteMessage(userId, id);
                }

                let res;
                if (options.buttons && options.buttons.length > 0) {
                    res = await channel.sendInteractive(userId, extra.caption || "", options.buttons, { ...options, media_url: video, media_type: 'video' });
                } else {
                    res = await channel.sendMessage(userId, extra.caption || "", { ...options, media_url: video, media_type: 'video' });
                }

                if (channel.type === 'whatsapp' && res.sentIds) this.userLastMessageIds.set(userId, res.sentIds);
                else if (channel.type === 'whatsapp' && res.messageId) this.userLastMessageIds.set(userId, [res.messageId]);
                return res;
            },
            answerCbQuery: async (text) => {
                console.log(`[CB-Answer] ${text || ''}`);
                // Utiliser le vrai answerCbQuery Telegraf si disponible
                if (msg.ctx?.answerCbQuery) {
                    return msg.ctx.answerCbQuery(text).catch(() => {});
                }
                return true;
            },
            deleteMessage: async (mid) => {
                const targetMid = mid || ctx.message?.message_id;
                if (!targetMid) return false;
                
                if (channel.type === 'whatsapp') return channel.deleteMessage(userId, targetMid);
                if (channel.type === 'telegram') {
                    const tgCh = registry.query('telegram');
                    const tgBot = tgCh?.getBotInstance?.();
                    if (tgBot) return tgBot.telegram.deleteMessage(userId, targetMid).catch(() => {});
                }
                return true;
            },
            editMessageText: async (text, extra = {}) => {
                ctx._handled = true;
                if (channel.type === 'telegram' && ctx.callbackQuery?.message) {
                    const tgCh = registry.query('telegram');
                    const tgBot = tgCh?.getBotInstance?.();
                    if (tgBot) {
                        try {
                            return await tgBot.telegram.editMessageText(userId, ctx.callbackQuery.message.message_id, null, text, { parse_mode: 'HTML', ...extra });
                        } catch (e) {
                            if (!String(e.description || '').includes('not modified')) console.warn('[Dispatcher] editMessageText failed:', e.message);
                        }
                    }
                }
                return ctx.reply(text, extra);
            }
        };

        return ctx;
    }

    _convertExtra(extra) {
        const options = {};
        let buttons = [];
        
        if (extra.reply_markup) {
            if (extra.reply_markup.inline_keyboard) {
                buttons = extra.reply_markup.inline_keyboard.flat();
            }
        } else if (extra.inline_keyboard) {
            buttons = extra.inline_keyboard.flat();
        }

        if (buttons.length > 0) {
            options.buttons = buttons.map(b => ({
                id: b.callback_data,
                title: b.text,
                url: b.url
            }));
            console.log(`[Dispatcher] Extracted ${options.buttons.length} buttons`);
        }
        
        if (extra.parse_mode === 'HTML') options.parse_mode = 'HTML';
        if (extra.photo) options.media_url = extra.photo;
        if (extra.caption) options.caption = extra.caption;
        return options;
    }

    async _route(ctx) {
        const text = ctx.message.text || '';
        const lowerText = text.toLowerCase().trim();
        const platform = ctx.platform.toUpperCase();
        console.log(`\n====== [${platform}] NOUVEAU MESSAGE ======`);
        console.log(`[${platform}] De: ${ctx.from.id} | Texte: "${text}" | Est un bouton: ${!!ctx.callbackQuery}`);

        // 1. Gestion des CALLBACKS (Boutons Telegram & Actions WhatsApp)
        if (ctx.callbackQuery) {
            const data = ctx.callbackQuery.data;
            console.log(`[${platform}] 🔘 BOUTON pressé: "${data}"`);
            const found = await this._routeAction(ctx, data);
            if (found) {
                console.log(`[${platform}] ✅ Handler trouvé et exécuté pour: "${data}"`);
            } else {
                console.log(`[${platform}] ❌ AUCUN handler pour le bouton: "${data}" — bouton non enregistré!`);
            }
            return;
        }

        // 2. Commande explicite /cmd
        if (text.startsWith('/')) {
            const cmd = text.split(' ')[0].substring(1);
            if (this.commands.has(cmd)) {
                console.log(`[${platform}] 📟 Commande /${cmd} trouvée`);
                return await this.commands.get(cmd)(ctx);
            }
            console.log(`[${platform}] ⚠️ Commande /${cmd} inconnue`);
        }

        // 3. Fallback: mots-clés courants → menu principal
        if (['menu', 'hi', 'bonjour', 'salut', 'hello', 'hey', 'yo', 'coucou', 'start', 'boutique', 'catalogue', 'commander', 'commande', 'aide', 'help'].includes(lowerText)) {
            console.log(`[${platform}] 🏠 Mot-clé menu → /start`);
            if (this.commands.has('start')) return await this.commands.get('start')(ctx);
        }

        // 3b. WhatsApp: auto-accueil si premier message (pas besoin de /start)
        if (ctx.platform === 'whatsapp' && !this.userLastButtons.has(ctx.from.id)) {
            console.log(`[${platform}] 🤝 Auto-welcome (premier message)`);
            if (this.commands.has('start')) return await this.commands.get('start')(ctx);
        }

        // 4. Handlers globaux (on text, message, etc.)
        console.log(`[${platform}] 📝 Passage dans ${this.onHandlers.filter(h=>h.type==='text').length} handlers texte...`);
        for (const h of this.onHandlers) {
            if (h.type === 'text' && ctx.message.text) {
                await h.fn(ctx, () => {});
            } else if (h.type === 'message') {
                await h.fn(ctx, () => {});
            } else if (h.type === 'location' && ctx.message.location) {
                await h.fn(ctx, () => {});
            }
        }

        // 5. WhatsApp: Fallback numérique seulement si non traité par le reste
        if (ctx.channel.type === 'whatsapp' && /^\d+$/.test(lowerText)) {
            console.log(`[${platform}] 🔢 PRÉ-FALLBACK: _handled=${ctx._handled}, texte="${lowerText}"`);
        }
        if (ctx.channel.type === 'whatsapp' && /^\d+$/.test(lowerText) && !ctx._handled) {
            const index = parseInt(lowerText) - 1;
            const lastButtons = this.userLastButtons.get(ctx.from.id);
            console.log(`[${platform}] 🔢 Raccourci numérique "${lowerText}" → index ${index}`);
            console.log(`[${platform}] 🗂️ Boutons mémorisés: ${lastButtons ? lastButtons.map(b=>b.id).join(', ') : 'AUCUN'}`);

            if (lastButtons && lastButtons[index]) {
                const btn = lastButtons[index];
                const trigger = btn.id || btn.callback_data;
                console.log(`[${platform}] ✅ Déclenchement: "${trigger}"`);
                if (trigger) await this._routeAction(ctx, trigger);
            } else if (!lastButtons) {
                console.log(`[${platform}] ❌ Pas de boutons mémorisés pour ${ctx.from.id} — envoyer /start d'abord`);
            } else {
                console.log(`[${platform}] ❌ Index ${index} hors limite (${lastButtons.length} boutons disponibles)`);
            }
        }
        console.log(`[${platform}] _handled: ${ctx._handled}`);
    }

    async _routeAction(ctx, data) {
        for (const [trigger, fn] of this.actions.entries()) {
            if (typeof trigger === 'string' && data === trigger) {
                try {
                    await fn(ctx);
                } catch(e) {
                    console.error(`[ROUTE-ERROR] Handler "${data}" a planté:`, e.message, e.stack?.split('\n')[1]);
                }
                return true;
            } else if (trigger instanceof RegExp) {
                const match = data.match(trigger);
                if (match) {
                    ctx.match = match;
                    try {
                        await fn(ctx);
                    } catch(e) {
                        console.error(`[ROUTE-ERROR] Handler regex "${trigger}" a planté:`, e.message, e.stack?.split('\n')[1]);
                    }
                    return true;
                }
            }
        }
        return false;
    }
}

const dispatcher = new Dispatcher();
module.exports = { dispatcher };
