const { Telegraf, Markup } = require('telegraf');
const { Channel } = require('./Channel');
const path = require('path');

class TelegramChannel extends Channel {
    constructor(token) {
        super('telegram', 'Telegram');
        this.token = token;
        this.bot = null;
        this.messageHandler = null;
    }

    onMessage(handler) {
        this.messageHandler = handler;
    }

    _resolveMedia(url) {
        if (typeof url === 'string' && url.startsWith('/public/')) {
            return { source: path.join(__dirname, '..', 'web', url) };
        }
        return url;
    }

    async initialize() {
        this.bot = new Telegraf(this.token);

        this.bot.use(async (ctx, next) => {
            const start = Date.now();
            await next();
            const ms = Date.now() - start;
            if (ctx.from) {
                console.log(
                    `[TG] @${ctx.from.username || ctx.from.id} — ${ctx.updateType} (${ms}ms)`
                );
            }
        });

        this.bot.catch((err, ctx) => {
            console.error('[TG] Erreur Global:', err.message);
        });

        // Relayer tout vers le dispatcher
        this.bot.on('message', async (ctx) => {
            if (this.messageHandler) {
                await this.messageHandler({
                    from: ctx.from.id,
                    name: ctx.from.first_name,
                    text: ctx.message.text || ctx.message.caption,
                    photo: ctx.message.photo,
                    video: ctx.message.video,
                    message_id: ctx.message.message_id,
                    type: 'message',
                    ctx: ctx // On garde le ctx original pour compatibilité ascendante si besoin
                });
            }
        });

        this.bot.on('callback_query', async (ctx) => {
            if (this.messageHandler) {
                await this.messageHandler({
                    from: ctx.from.id,
                    name: ctx.from.first_name,
                    text: ctx.callbackQuery.data,
                    type: 'callback_query',
                    isAction: true,
                    ctx: ctx
                });
            }
        });
    }

    async start() {
        console.log(`[TG] Lancement du bot (${this.token.substring(0, 4)}****...)...`);
        try {
            this.bot.launch().then(() => {
                console.log('✅ [TG] Bot lancé avec succès !');
                this.isActive = true;
            }).catch(err => {
                console.error('❌ [TG] Erreur fatale au lancement:', err.message);
            });
            // On ne bloque pas tout le démarrage si Telegram met du temps
            this.isActive = true;
            console.log('  Telegram channel initialized and marked active');
        } catch (err) {
            console.error('❌ [TG] Exception lors du launch:', err.message);
        }
    }

    async stop() {
        if (this.bot) this.bot.stop('SIGTERM');
        this.isActive = false;
    }

    async sendMessage(chatId, text, options = {}) {
        console.log(`[TG] Tentative d'envoi à ${chatId}...`);
        try {
            // Si options contient media_url, on redirige
            if (options.media_url) {
                if (options.media_type === 'multiple') {
                    try {
                        const mediaArray = JSON.parse(options.media_url);
                        return this.sendMediaGroup(chatId, mediaArray, text, options);
                    } catch (e) {
                        console.error("JSON Parse multiple failed:", e);
                    }
                } else if (options.media_type === 'video') {
                    return this.sendVideo(chatId, options.media_url, text, options);
                } else {
                    return this.sendPhoto(chatId, options.media_url, text, options);
                }
            }

            // Vérifier si le texte contient du HTML intentionnel
            const hasHtmlTags = text.match(/<[a-z/][\s\S]*>/i);

            let finalMsg = text;
            if (!hasHtmlTags) {
                finalMsg = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }

            const extra = { parse_mode: 'HTML' };
            if (options.reply_markup) extra.reply_markup = options.reply_markup;
            else if (options.inline_keyboard || options.keyboard) extra.reply_markup = options;

            await this.bot.telegram.sendMessage(chatId, finalMsg, extra);
            return { success: true };
        } catch (error) {
            console.error(`[TG] Erreur d'envoi à ${chatId}:`, error);
            return this._handleError(error);
        }
    }

    async sendPhoto(chatId, url, caption, options = {}) {
        try {
            const extra = { parse_mode: 'HTML', caption: caption };
            if (options.reply_markup) extra.reply_markup = options.reply_markup;
            else if (options.inline_keyboard || options.keyboard) extra.reply_markup = options;

            await this.bot.telegram.sendPhoto(chatId, this._resolveMedia(url), extra);
            return { success: true };
        } catch (error) {
            console.error(`[TG] Erreur photo à ${chatId}:`, error);
            return this._handleError(error);
        }
    }

    async sendVideo(chatId, url, caption, options = {}) {
        try {
            const extra = { parse_mode: 'HTML', caption: caption };
            if (options.reply_markup) extra.reply_markup = options.reply_markup;
            else if (options.inline_keyboard || options.keyboard) extra.reply_markup = options;

            await this.bot.telegram.sendVideo(chatId, this._resolveMedia(url), extra);
            return { success: true };
        } catch (error) {
            console.error(`[TG] Erreur vidéo à ${chatId}:`, error);
            return this._handleError(error);
        }
    }

    async sendMediaGroup(chatId, mediaArray, caption, options = {}) {
        try {
            const telegramMedia = mediaArray.map((m, index) => {
                const item = {
                    type: m.type,
                    media: this._resolveMedia(m.url),
                };
                if (index === 0) { // On met la légende seulement sur le premier élément
                    item.caption = caption;
                    item.parse_mode = 'HTML';
                }
                return item;
            });
            await this.bot.telegram.sendMediaGroup(chatId, telegramMedia);
            return { success: true };
        } catch (error) {
            console.error(`[TG] Erreur MediaGroup à ${chatId}:`, error);
            return this._handleError(error);
        }
    }

    async sendInteractive(userId, text, buttons = []) {
        // En Telegram, interactiveButtons = Inline Keyboard
        const keyboard = buttons.map((b) => {
            // Sécurité: si c'est un lien URL
            if (b.url) return [Markup.button.url(b.title, b.url)];
            // Sinon c'est un callback
            return [Markup.button.callback(b.title, b.id)];
        });

        return this.sendMessage(userId, text, {
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    _handleError(error) {
        const code = error.response?.error_code;
        const desc = error.response?.description || error.message;
        const BLOCKED_SIGNALS = ['bot was blocked', 'user is deactivated', 'chat not found'];

        const result = { success: false, error: desc };

        if (code === 403 || BLOCKED_SIGNALS.some((s) => desc.includes(s))) {
            result.blocked = true;
        } else if (code === 429) {
            result.rateLimited = true;
            result.retryAfter = error.response?.parameters?.retry_after || 5;
        }
        return result;
    }

    getCapabilities() {
        return {
            hasSessionWindow: false,
            supportsHTML: true,
            supportsInlineKeyboard: true,
            supportsInteractiveButtons: true,
        };
    }

    getBotInstance() { return this.bot; }
}

module.exports = { TelegramChannel };
