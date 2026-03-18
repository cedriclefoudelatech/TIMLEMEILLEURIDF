const Baileys = require('@whiskeysockets/baileys');
const makeWASocket = Baileys.default || Baileys;
const { DisconnectReason, jidDecode, fetchLatestBaileysVersion } = Baileys;

const { Channel } = require('./Channel');
const { useSupabaseAuthState } = require('../services/database');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode');



// Logs circulaires pour debug en live via /wa-logs
const waLogs = [];
function waLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    waLogs.push(line);
    if (waLogs.length > 200) waLogs.shift();
    console.log(line);
}

class WhatsAppSessionChannel extends Channel {
    constructor(config) {
        super('whatsapp', 'WhatsApp (Session)');
        this.sessionId = config.sessionId || 'default';
        this.sock = null;
        this.messageHandler = null;
        this.store = null;
        this._restarting = false;
        this._clearSession = null; // Sera défini dans start()
        this._conflictBackoff = 5000; // Backoff initial pour code 440 (ms)
    }

    static getLogs() { return waLogs; }

    async initialize() {
        console.log(`[WA-Session] Supabase mode for: ${this.sessionId}`);
    }

    async start() {
        const { state, saveCreds, clearSession } = await useSupabaseAuthState(this.sessionId);
        this._clearSession = clearSession;
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WA] Using version v${version.join('.')}, isLatest: ${isLatest}`);

        this.sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });


        // this.store.bind(this.sock.ev); // Removed store bind

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            waLog(`[WA] Connection Update: ${JSON.stringify(update, null, 2)}`);

            if (qr) {
                console.log('--------------------------------------------------');
                console.log('👉 SCANNEZ CE QR CODE POUR CONNECTER WHATSAPP :');
                qrcodeTerminal.generate(qr, { small: true });
                console.log('--------------------------------------------------');

                // Sauvegarder en image pour le web endpoint /whatsapp-qr
                try {
                    const artifactPath = path.join(process.cwd(), 'whatsapp_qr.png');
                    await qrcodeImage.toFile(artifactPath, qr, {
                        color: { dark: '#000000', light: '#ffffff' },
                        width: 256
                    });
                    console.log(`✅ QR Image générée: ${artifactPath}`);
                } catch (err) {
                    console.error('❌ Erreur génération image QR:', err);
                }
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                waLog(`[WA] Connexion fermée. Code: ${statusCode}, Msg: ${error?.message}, Payload: ${JSON.stringify(error?.output?.payload)}`);

                // Si on est en restart, ne pas reconnecter (restart() s'en charge)
                if (this._restarting) {
                    waLog('[WA] Restart en cours, pas de reconnexion auto.');
                    return;
                }

                // Codes qui nécessitent une session fraîche (nouveau QR)
                const needsFreshSession = [
                    DisconnectReason.loggedOut,   // 401 - déconnecté par l'utilisateur
                    DisconnectReason.forbidden,    // 403 - compte banni/bloqué
                    DisconnectReason.badSession,   // 500 - session corrompue
                    DisconnectReason.multideviceMismatch, // 411 - conflit appareils
                ].includes(statusCode);

                if (needsFreshSession) {
                    waLog(`[WA] Session invalide (code ${statusCode}) — effacement Supabase et nouveau QR.`);
                    if (this._clearSession) await this._clearSession();
                    this.isActive = false;
                    await this.start(); // Repart avec credentials vides → génère un QR
                } else if (statusCode === 440) {
                    // Conflit : une autre instance a pris la session.
                    // Backoff exponentiel pour éviter la boucle infinie de conflits.
                    const delay = this._conflictBackoff;
                    this._conflictBackoff = Math.min(this._conflictBackoff * 2, 60000); // max 60s
                    waLog(`[WA] Conflit 440 (replaced) — attente ${delay}ms avant reconnexion (backoff=${this._conflictBackoff}ms)...`);
                    this.isActive = false;
                    setTimeout(() => this.start(), delay);
                } else {
                    // Reconnexion simple (timeout, perte réseau, etc.)
                    this._conflictBackoff = 5000; // reset backoff sur reconnexion normale
                    waLog(`[WA] Reconnexion simple (code ${statusCode})...`);
                    this.start();
                }
            } else if (connection === 'open') {
                waLog('✅ [WA] WhatsApp connecté avec succès !');
                this.isActive = true;
                this._conflictBackoff = 5000; // reset backoff sur connexion réussie
            }
        });


        this.sock.ev.on('messages.upsert', async (m) => {
            console.log(`[WA-Debug] Event messages.upsert type=${m.type}, count=${m.messages?.length}`);
            if (m.type !== 'notify') return;
            const selfJid = this.sock.user?.id;

            for (const msg of m.messages) {
                const remoteJid = msg.key.remoteJid;
                const isMe = msg.key.fromMe;

                // Ignorer les messages de protocole sans contenu utile
                if (!msg.message || msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) continue;

                const selfJidClean = selfJid?.split(':')[0];
                const remoteJidClean = remoteJid?.split('@')[0].split(':')[0];
                const isMessageToSelf = remoteJidClean === selfJidClean;

                // Détecter si le message vient d'un BOT (Baileys ou autre bot instance)
                const isBotId = msg.key.id.startsWith('BAE5') || msg.key.id.startsWith('3EB0') || msg.key.id.length > 20;

                console.log(`[WA-Debug] MSG: fromMe=${isMe}, isBotId=${isBotId}, remoteJid=${remoteJid}, toSelf=${isMessageToSelf}`);

                // Empêcher les boucles : on ignore tout ce qui est marqué fromMe SAUF si c'est nous qui écrivons manuellement (pas un ID de bot)
                if (isMe && isBotId) continue;
                // Si c'est un message "To Self" (notre propre compte), on accepte seulement si c'est un message manuel (pas du bot)
                if (isMe && !isBotId && isMessageToSelf) {
                    // C'est l'utilisateur humain qui écrit à son propre bot, on continue
                } else if (isMe) {
                    // C'est un message envoyé par le bot vers quelqu'un d'autre ou par nous manuellement vers quelqu'un d'autre
                    continue;
                }

                const name = msg.pushName || 'User';
                const text = this._extractText(msg);
                const isAction = !!(msg.message?.listResponseMessage || msg.message?.buttonsResponseMessage);

                // Extraction média (Image/Vidéo)
                let photo = null;
                let video = null;
                const m2 = msg.message;
                if (m2?.imageMessage) {
                    photo = [{ file_id: msg.key.id, isWa: true, msg: msg }];
                } else if (m2?.videoMessage) {
                    video = [{ file_id: msg.key.id, isWa: true, msg: msg }];
                }

                if (this.messageHandler && (text || photo || video)) {
                    console.log(`[WA-In] Text: "${text}" | Photo: ${!!photo} | Video: ${!!video} | Action: ${isAction} | From: ${remoteJid}`);
                    await this.messageHandler({
                        from: remoteJid,
                        name: name,
                        text: text,
                        photo: photo,
                        video: video,
                        type: video ? 'video' : (photo ? 'photo' : 'text'),
                        isAction: isAction,
                        raw: msg
                    });
                }
            }
        });




    }

    async stop() {
        if (this.sock) this.sock.end();
        this.isActive = false;
    }

    async restart() {
        waLog('[WA] Restart demandé — nettoyage session Supabase et reconnexion...');
        this._restarting = true;
        // 1. Fermer la connexion existante
        if (this.sock) {
            try { this.sock.end(); } catch (e) {}
            this.sock = null;
        }
        this.isActive = false;
        // 2. Supprimer la session Supabase pour forcer un nouveau QR
        if (this._clearSession) {
            await this._clearSession();
            waLog('[WA] Session Supabase supprimée.');
        }
        // 3. Supprimer l'ancien QR image
        const qrPath = path.join(process.cwd(), 'whatsapp_qr.png');
        if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
        // 4. Redémarrer
        this._restarting = false;
        await this.start();
    }

    onMessage(handler) { this.messageHandler = handler; }

    async sendMessage(userId, text, options = {}) {
        if (!this.sock || !this.isActive) return { success: false, error: 'Not connected' };

        // Sécurité JID: on s'assure que l'ID a le bon suffixe si c'est un pur numéro
        const jid = (userId.includes('@')) ? userId : `${userId}@s.whatsapp.net`;
        const cleanText = this._stripHTML(text);

        try {
            let result;
            if (options.source || options.media_url) {
                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                const msgPayload = {
                    [mediaType]: options.source ? options.source : { url: options.media_url },
                    caption: cleanText
                };
                result = await this.sock.sendMessage(jid, msgPayload);
            } else {
                result = await this.sock.sendMessage(jid, { text: cleanText });
            }
            return { success: true, messageId: result?.key?.id };
        } catch (e) {
            console.error('[WA-Send] Error:', e);
            return { success: false, error: e.message };
        }
    }

    async deleteMessage(jid, messageId) {
        if (!this.sock || !this.isActive || !messageId) return;
        try {
            await this.sock.sendMessage(jid, {
                delete: {
                    remoteJid: jid,
                    fromMe: true,
                    id: messageId,
                    participant: undefined
                }
            });
            return true;
        } catch (e) {
            console.error('[WA-Delete] Error:', e);
            return false;
        }
    }

    async sendInteractive(userId, text, buttons = [], options = {}) {
        if (!this.sock || !this.isActive) {
            console.warn(`[WA-Interactive] Socket non disponible (isActive=${this.isActive}, sockNull=${!this.sock}) — message non envoyé à ${userId}`);
            return { success: false, sentIds: [], error: 'Not connected' };
        }

        const jid = (userId.includes('@')) ? userId : `${userId}@s.whatsapp.net`;
        const sentIds = [];
        console.log(`[WA-Interactive] To: ${jid}, Buttons: ${buttons.length}, HasMedia: ${!!options.media_url}`);

        const cleanText = this._stripHTML(text);
        let textMenu = cleanText;

        // Préparer le menu textuel si des boutons sont présents
        if (buttons.length > 0) {
            if (textMenu) textMenu += "\n\n";
            textMenu += "*📋 OPTIONS DISPONIBLES :*\n";
            buttons.forEach((b, i) => {
                textMenu += `*${i+1}* — ${b.title}\n`;
            });
            textMenu += "\n_Répondez avec le chiffre correspondant._";
        }

        // 1. Tentative envoi avec média (si présent)
        if (options.source || options.media_url) {
            try {
                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                const msgPayload = {
                    [mediaType]: options.source ? options.source : { url: options.media_url },
                    caption: textMenu || ""
                };
                const result = await this.sock.sendMessage(jid, msgPayload);
                if (result?.key?.id) sentIds.push(result.key.id);
                return { success: true, sentIds };
            } catch (e) {
                console.warn(`[WA-Interactive] Échec envoi média (${options.media_url || 'source buffer'}) — fallback texte seul. Erreur: ${e.message}`);
                // Fallback : envoyer texte seul ci-dessous
            }
        }

        // 2. Envoi Texte seul (aussi utilisé comme fallback si le média échoue)
        try {
            const result = await this.sock.sendMessage(jid, { text: textMenu || "Choisissez une option :" });
            if (result?.key?.id) sentIds.push(result.key.id);
            return { success: true, sentIds };
        } catch (e) {
            console.error('[WA-Interactive] Échec envoi texte:', e);
            return { success: false, sentIds };
        }
    }

    _extractText(msg) {
        const m = msg.message;
        const text = m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                     m?.buttonsResponseMessage?.selectedButtonId ||
                     m?.conversation ||
                     m?.extendedTextMessage?.text ||
                     m?.imageMessage?.caption ||
                     m?.videoMessage?.caption ||
                     "";
        return text;
    }

    async downloadMedia(msg) {
        try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                {
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: this.sock.updateMediaMessage
                }
            );
            return buffer;
        } catch (e) {
            console.error('[WA-Download] Error:', e.message);
            return null;
        }
    }

    _stripHTML(text) {
        if (!text) return '';
        // Conversion basique HTML -> WA Markdown
        let t = text
            .replace(/<b[^>]*>(.*?)<\/b>/gi, '*$1*')
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '*$1*')
            .replace(/<i[^>]*>(.*?)<\/i>/gi, '_$1_')
            .replace(/<em[^>]*>(.*?)<\/em>/gi, '_$1_')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/&nbsp;/g, ' ');

        // Supprimer toutes les autres balises
        return t.replace(/<[^>]*>/g, '').trim();
    }

    _normalizeId(id) {
        if (!id) return id;
        const s = String(id);
        // Toujours normaliser vers @s.whatsapp.net pour éviter les doublons @lid
        if (s.includes('@s.whatsapp.net')) {
            return s.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        }
        if (s.includes('@lid')) {
            return s.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        }
        return s;
    }
}

module.exports = { WhatsAppSessionChannel };
