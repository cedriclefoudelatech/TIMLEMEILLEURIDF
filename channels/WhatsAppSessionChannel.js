// Dynamic import wrapper for ESM-only @whiskeysockets/baileys (Node 22+)
let Baileys, makeWASocket, DisconnectReason, jidDecode, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage;

async function loadBaileys() {
    if (Baileys) return;
    Baileys = await import('@whiskeysockets/baileys');
    makeWASocket = Baileys.default?.default || Baileys.default || Baileys;
    DisconnectReason = Baileys.DisconnectReason;
    jidDecode = Baileys.jidDecode;
    fetchLatestBaileysVersion = Baileys.fetchLatestBaileysVersion;
    makeCacheableSignalKeyStore = Baileys.makeCacheableSignalKeyStore;
    downloadMediaMessage = Baileys.downloadMediaMessage;
}

const { Channel } = require('./Channel');
const { useSupabaseAuthState } = require('../services/database');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode');



const { waLogs, waLog } = require('../services/wa_log_shared');

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
        this._failureCount = 0; // Compteur pour éviter les boucles infinies
        this.lastQR = null; // Stocke le dernier QR en Base64
    }

    static getLogs() { return waLogs; }

    async initialize() {
        await loadBaileys();
        console.log(`[WA-Session] Supabase mode for: ${this.sessionId}`);
    }

    async start() {
        if (this.sock) { try { this.sock.end(); } catch(e) {} this.sock = null; }
        await loadBaileys();
        const { state, saveCreds, clearSession, claimLock, checkLock, releaseLock } = await useSupabaseAuthState(this.sessionId).catch(err => {
            waLog(`[WA-START-ERR] DB Initialize failed: ${err.message}. Retrying in 10s...`);
            setTimeout(() => this.start(), 10000);
            throw err;
        });
        this._clearSession = clearSession;
        this._releaseLock = releaseLock;

        // --- LOCK SYSTEM (PREVENTS CONFLICT 440) ---
        const myInstanceId = `${process.env.RAILWAY_SERVICE_NAME || 'local'}-${process.env.RAILWAY_REPLICA_INDEX || '0'}-${process.pid}`;
        let activeLock;
        try {
            activeLock = await checkLock();
        } catch (e) {
            waLog(`[WA-LOCK-ERR] Could not check lock: ${e.message}. Retrying...`);
            setTimeout(() => this.start(), 5000);
            return;
        }
        
        if (activeLock && activeLock.owner !== myInstanceId) {
            const now = Date.now();
            const updatedAt = activeLock.updatedAt || 0;
            const diff = now - updatedAt;

            // Si le lock existe et qu'il a été mis à jour il y a moins de 60 secondes, il est ACTIF
            if (activeLock.owner && diff < 60000) {
                const waitTime = 10000;
                waLog(`[WA-LOCK] Session busy (owned by ${activeLock.owner}, updated ${Math.round(diff/1000)}s ago). Waiting ${waitTime}ms to avoid conflict 440...`);
                this.isActive = false;
                setTimeout(() => this.start(), waitTime);
                return;
            }
        }
        
        // Prendre le lock
        await claimLock(myInstanceId).catch(e => waLog(`[WA-LOCK-ERR] Claim failed: ${e.message}`));
        waLog(`[WA-LOCK] Session locked for our instance: ${myInstanceId}`);
        this.isActive = true; 

        // [🛡️ HEARTBEAT] Garder le lock vivant
        if (this._lockHeartbeat) clearInterval(this._lockHeartbeat);
        this._lockHeartbeat = setInterval(async () => {
             await claimLock(myInstanceId).catch(() => {});
        }, 15000);

        // Suppression de la version forcée pour laisser Baileys détecter la plus appropriée
        const logger = pino({ level: 'silent' });
        this.sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore({
                    get: async (type, ids) => {
                        const data = await state.keys.get(type, ids);
                        for (const id in data) {
                            if (type === 'app-state-sync-key' && data[id]) {
                                // Important pour décrypter correctement les messages AppState
                                data[id] = proto.Message.AppStateSyncKeyData.fromObject(data[id]);
                            }
                        }
                        return data;
                    },
                    set: (data) => state.keys.set(data)
                }, logger)
            },
            logger,
            browser: ["Mac OS", "Chrome", "122.0.0.0"],
            syncFullHistory: false,
            shouldSyncHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 60000,
            transactionOpts: { maxRetries: 10, delayBetweenTriesMs: 1000 },
            getMessage: async () => ({ conversation: '' })
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
                    
                    // Stockage en mémoire (Base64) pour affichage direct
                    this.lastQR = await qrcodeImage.toDataURL(qr);
                } catch (err) {
                    console.error('❌ Erreur génération image QR:', err);
                }
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                this.isActive = false; // Désactiver immédiatement le canal pour stopper les envois
                waLog(`[WA] Connexion fermée. Code: ${statusCode}, Msg: ${error?.message}, Payload: ${JSON.stringify(error?.output?.payload)}`);

                // Si on est en restart, ne pas reconnecter (restart() s'en charge)
                if (this._restarting) {
                    waLog('[WA] Restart en cours, pas de reconnexion auto.');
                    return;
                }

                // Codes qui nécessitent une session fraîche (nouveau QR)
                const needsFreshSession = [
                    DisconnectReason.loggedOut,   // 401
                    DisconnectReason.forbidden,    // 403
                    DisconnectReason.badSession,   // 500
                    DisconnectReason.multideviceMismatch, // 411
                    405, // Method Not Allowed
                    428, // Precondition Required
                ].includes(statusCode);

                if (needsFreshSession) {
                    this._failureCount++;
                    if (this._failureCount > 20) {
                        waLog(`[WA-CRIT] Trop d'échecs (${this._failureCount}). Arrêt.`);
                        return;
                    }

                    waLog(`[WA] Session CRITIQUE (${statusCode}, tentative ${this._failureCount}) — Purge et restart 10s...`);
                    if (this._clearSession) await this._clearSession().catch(() => {});
                    setTimeout(() => this.start(), 10000); 
                } else if (statusCode === 440) {
                    // Conflit : une autre instance a pris la session.
                    const delay = this._conflictBackoff;
                    this._conflictBackoff = Math.min(this._conflictBackoff * 2, 60000); // max 60s
                    waLog(`[WA] Conflit 440 — attente ${delay}ms...`);
                    this.isActive = false;
                    setTimeout(() => this.start(), delay);
                } else {
                    waLog(`[WA] Reconnexion simple (code ${statusCode}) dans 10s...`);
                    setTimeout(() => this.start(), 10000);
                }
            } else if (connection === 'open') {
                waLog('✅ [WA] WhatsApp connecté avec succès !');
                this.isActive = true;
                this._failureCount = 0; // Reset sur succès
                this._conflictBackoff = 5000;
            }
        });


        this.sock.ev.on('messages.upsert', async (m) => {
            waLog(`[WA-MSG] messages.upsert type=${m.type}, count=${m.messages?.length}`);
            if (m.type !== 'notify') {
                waLog(`[WA-MSG] SKIP: type=${m.type} (not notify)`);
                return;
            }
            const selfJid = this.sock.user?.id;
            waLog(`[WA-MSG] selfJid=${selfJid}`);

            for (const msg of m.messages) {
                const remoteJid = msg.key.remoteJid;
                const isMe = msg.key.fromMe;

                // Ignorer les messages de protocole sans contenu utile
                if (!msg.message || msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) {
                    waLog(`[WA-MSG] SKIP protocol/empty from ${remoteJid}`);
                    continue;
                }

                const selfJidClean = selfJid?.split(':')[0];
                const remoteJidClean = remoteJid?.split('@')[0].split(':')[0];
                const isMessageToSelf = remoteJidClean === selfJidClean || remoteJid?.endsWith('@lid');

                // Détecter si le message vient d'un BOT (Baileys ou autre bot instance)
                const isBotId = msg.key.id.startsWith('BAE5') || msg.key.id.startsWith('3EB0') || msg.key.id.length > 20;

                waLog(`[WA-MSG] fromMe=${isMe}, isBotId=${isBotId}, remoteJid=${remoteJid}, toSelf=${isMessageToSelf}, msgKeys=${Object.keys(msg.message || {}).join(',')}`);

                // Empêcher les boucles : on ignore tout ce qui est marqué fromMe SAUF si c'est nous qui écrivons manuellement (pas un ID de bot)
                if (isMe && isBotId) { waLog(`[WA-MSG] SKIP: fromMe+botId`); continue; }
                // Si c'est un message "To Self" (notre propre compte), on accepte seulement si c'est un message manuel (pas du bot)
                if (isMe && !isBotId && isMessageToSelf) {
                    waLog(`[WA-MSG] ACCEPT: self-message from human`);
                } else if (isMe) {
                    waLog(`[WA-MSG] SKIP: fromMe outbound`);
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

                waLog(`[WA-MSG] text="${text}", photo=${!!photo}, video=${!!video}, handler=${!!this.messageHandler}`);

                if (this.messageHandler && (text || photo || video)) {
                    waLog(`[WA-In] Processing: "${text}" from ${remoteJid}`);
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

    async requestPairingCode(phoneNumber) {
        if (!this.sock || !this.isActive) {
            waLog(`[WA-Pairing] Socket non actif, tentative de démarrage...`);
            await this.initialize();
            await this.start();
        }
        
        // Attendre que le socket soit prêt (timeout augmenté à 45s car Railway peut être lent)
        let attempts = 0;
        while (!this.sock && attempts < 45) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (!this.sock) throw new Error("Socket non initialisé");

        // Baileys requestPairingCode
        const code = await this.sock.requestPairingCode(phoneNumber);
        return code;
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

    _resolveMedia(url) {
        if (typeof url !== 'string') return url;
        if (url.startsWith('http') || url.startsWith('data:')) return url;
        // Si c'est un chemin commençant par /public/ ou relatif, on le résout par rapport au CWD
        let relative = url.startsWith('/') ? url.substring(1) : url;
        const absolute = path.join(process.cwd(), relative);
        if (fs.existsSync(absolute)) return absolute;
        // Fallback spécifique pour web/public/...
        const webPublic = path.join(process.cwd(), 'web', relative);
        if (fs.existsSync(webPublic)) return webPublic;
        return url;
    }

    onMessage(handler) { this.messageHandler = handler; }

    async sendMessage(userId, text, options = {}) {
        const jid = this._normalizeId(userId);
        
        if (!this.sock || !this.isActive) {
            waLog(`[WA-Send-Error] Disconnected! State: ${!!this.sock ? 'WaitSock' : 'NoSock'}, Active: ${this.isActive} | To: ${jid}`);
            return { success: false, error: 'WhatsApp not connected or session locked' };
        }

        waLog(`[WA-Send] Sending to ${jid} | HasMedia: ${!!(options.source || options.media_url)}`);
        const cleanText = this._stripHTML(text);

        try {
            let result;
            if (options.source || options.media_url) {
                let mediaSource = options.source;
                let mediaUrl = this._resolveMedia(options.media_url);

                // Si c'est un chemin local et qu'on n'a pas encore de buffer (source)
                if (!mediaSource && typeof mediaUrl === 'string' && fs.existsSync(mediaUrl)) {
                    try {
                        mediaSource = fs.readFileSync(mediaUrl);
                        mediaUrl = null;
                    } catch (e) {
                        console.error(`[WA-Send] Error reading local file ${mediaUrl}:`, e.message);
                    }
                }

                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                const msgPayload = {
                    [mediaType]: mediaSource ? mediaSource : { url: mediaUrl },
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
                const label = b.title || b.text || 'Option';
                const link = b.url ? `\n🔗 ${b.url}` : '';
                textMenu += `*${i+1}* — ${label}${link}\n`;
            });
            textMenu += "\n_Répondez avec le chiffre correspondant._";
        }

        // 1. Tentative envoi avec média (si présent)
        if (options.source || options.media_url) {
            try {
                let mediaSource = options.source;
                let mediaUrl = this._resolveMedia(options.media_url);

                // Détecter chemin local absolute pour WhatsApp
                if (!mediaSource && typeof mediaUrl === 'string' && fs.existsSync(mediaUrl)) {
                    try {
                        mediaSource = fs.readFileSync(mediaUrl);
                        mediaUrl = null;
                    } catch (e) { }
                }

                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                const msgPayload = {
                    [mediaType]: mediaSource ? mediaSource : { url: mediaUrl },
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
            await loadBaileys();
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
        let s = String(id).trim();
        
        // Remove 'whatsapp_' prefix if present (from notifications.js)
        if (s.startsWith('whatsapp_')) s = s.replace('whatsapp_', '');

        if (s.includes('@s.whatsapp.net')) {
            return s.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        }
        if (s.includes('@lid')) {
            return s.split(':')[0].split('@')[0] + '@lid';
        }
        
        // Default to s.whatsapp.net if no suffix
        if (!s.includes('@')) return s + '@s.whatsapp.net';
        
        return s;
    }
}

module.exports = { WhatsAppSessionChannel };
