// Dynamic import wrapper for ESM-only @whiskeysockets/baileys (Node 22+)
let Baileys, makeWASocket, DisconnectReason, jidDecode, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage, Browsers, proto, jidNormalizedUser;

async function loadBaileys() {
    if (Baileys) return;
    Baileys = await import('@whiskeysockets/baileys');
    makeWASocket = Baileys.default?.default || Baileys.default || Baileys;
    DisconnectReason = Baileys.DisconnectReason;
    jidDecode = Baileys.jidDecode;
    jidNormalizedUser = Baileys.jidNormalizedUser;
    fetchLatestBaileysVersion = Baileys.fetchLatestBaileysVersion;
    makeCacheableSignalKeyStore = Baileys.makeCacheableSignalKeyStore;
    downloadMediaMessage = Baileys.downloadMediaMessage;
    Browsers = Baileys.Browsers;
    proto = Baileys.proto;
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
        this._decryptionFailures = 0;
        this._clearSession = null; // Sera défini dans start()
        this._conflictBackoff = 5000; // Backoff initial pour code 440 (ms)
        this._failureCount = 0; // Compteur pour éviter les boucles infinies
        this.lastQR = null; // Stocke le dernier QR en Base64
        this.pairingPhone = null;
        this.pairingCode = null;
    }

    static getLogs() { return waLogs; }

    async initialize() {
        await loadBaileys();
        console.log(`[WA-Session] Supabase mode for: ${this.sessionId}`);
    }

    async start(options = {}) {
        if (this._isStarting) {
            waLog(`[WA-START] Démarrage déjà en cours ignoré pour éviter conflit 440.`);
            return;
        }
        this._isStarting = true;
        if (this.sock) { try { this.sock.end(); } catch(e) {} this.sock = null; }
        await loadBaileys();
        if (options.pairingPhone) {
            this.pairingPhone = options.pairingPhone;
            this.pairingCode = null;
            waLog(`[WA-Pairing] Mode jumelage activé pour : ${this.pairingPhone}`);
        }
        const { state, saveCreds, clearSession, claimLock, checkLock, releaseLock } = await useSupabaseAuthState(this.sessionId).catch(err => {
            setTimeout(() => this.start(options), 10000);
            throw err;
        });
        this._failureCount = 0; // Reset failure count on manual start/restart
        this._clearSession = clearSession;
        // [🛡️ LOCK SYSTEM] On s'assure que seule une instance utilise la session à la fois.
        this._releaseLock = releaseLock;

        const wrappedSaveCreds = async () => {
            try {
                await saveCreds();
                waLog(`[WA-DB] ✅ Credentials sauvegardés pour ${this.sessionId}`);
            } catch (err) {
                waLog(`[WA-DB-ERR] ❌ Échec sauvegarde credentials: ${err.message}`);
            }
        };

        // --- LOCK SYSTEM (PREVENTS CONFLICT 440) ---
        const myInstanceId = `${process.env.RAILWAY_SERVICE_NAME || 'local'}-${process.env.RAILWAY_REPLICA_INDEX || '0'}-${process.pid}`;
        
        // [🛡️ SÉCURITÉ] On force la libération du verrou précédent si on est en train de redémarrer
        await releaseLock().catch(() => {});
        
        let activeLock;
        try {
            activeLock = await checkLock();
        } catch (e) {
            waLog(`[WA-LOCK-ERR] Could not check lock: ${e.message}. Retrying...`);
            this._isStarting = false;
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
                this._isStarting = false;
                setTimeout(() => this.start(options), waitTime);
                return;
            }
        }
        
        // Prendre le lock
        await claimLock(myInstanceId).catch(e => waLog(`[WA-LOCK-ERR] Claim failed: ${e.message}`));
        waLog(`[WA-LOCK] Session locked for our instance: ${myInstanceId}`);
        // isActive sera true uniquement sur connection='open'

        // [🛡️ HEARTBEAT] Garder le lock vivant
        if (this._lockHeartbeat) clearInterval(this._lockHeartbeat);
        this._lockHeartbeat = setInterval(async () => {
             await claimLock(myInstanceId).catch(() => {});
        }, 15000);

        // [🛡️ STABILITÉ] Récupération de la dernière version avec fallback
        let version = [2, 3000, 1015901307];
        try {
            const latest = await fetchLatestBaileysVersion().catch(() => null);
            if (latest && latest.version) version = latest.version;
        } catch (e) {}
        waLog(`[WA] Using version v${version.join('.')}`);

        const logger = pino({ level: 'silent' });
        
        // [🛡️ RETRY] Cache pour les retries de déchiffrement
        // Quand un message ne peut pas être déchiffré, Baileys demande au sender de le renvoyer
        if (!this._msgRetryCounterCache) {
            this._msgRetryCounterCache = new Map();
            this._msgRetryCounterCache.del = this._msgRetryCounterCache.delete.bind(this._msgRetryCounterCache);
        }
        
        this.sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger,
            browser: Browsers.ubuntu('Chrome'), // Signature Ubuntu plus stable sur Railway (évite les 401)
            syncFullHistory: false,
            shouldSyncHistory: false,
            markOnlineOnConnect: true, // [🛡️ STABILITÉ] Réactivé pour favoriser le déchiffrement initial
            connectTimeoutMs: 90000,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: true,
            retryRequestDelayMs: 2000,
            transactionOpts: { maxRetries: 5, delayBetweenTriesMs: 2000 },
            msgRetryCounterCache: this._msgRetryCounterCache,
            getMessage: async (key) => {
                // Callback utilisé par Baileys pour les retries de déchiffrement
                // On retourne undefined pour forcer Baileys à demander au sender de renvoyer
                waLog(`[WA-RETRY] getMessage demandé pour ${key?.remoteJid} (id=${key?.id?.substring(0,12)})`);
                return undefined;
            }
        });

        // [🛡️ STABILITÉ] On ne libère plus _isStarting ici, mais dans connection.update (open ou close)
        // Cela garantit qu'on ne lance pas deux sockets en parallèle pendant la phase de poignée de main

        // this.store.bind(this.sock.ev); // Removed store bind

        this.sock.ev.on('creds.update', wrappedSaveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            waLog(`[WA] Connection Update: ${JSON.stringify(update, null, 2)}`);
            if (qr) {
                try {
                    // Stockage en mémoire (Base64) pour affichage direct
                    this.lastQR = await qrcodeImage.toDataURL(qr);

                    // [🏁 MÉTHODE LE RELAIS] On demande le code de pairing UNIQUEMENT quand le QR est émis
                    if (this.pairingPhone && !this.sock.authState.creds.registered && !this.pairingCode && !this._pairingRequested) {
                        this._pairingRequested = true;
                        const retryPairing = async (attempt = 1) => {
                            if (attempt > 3 || this.pairingCode) return;
                            waLog(`[WA-Pairing] Tentative ${attempt}/3 (Méthode Le Relais) : demande de code pour ${this.pairingPhone}...`);
                            try {
                                const cleanPhone = this.pairingPhone.replace(/\D/g, '');
                                const code = await this.sock.requestPairingCode(cleanPhone);
                                this.pairingCode = code;
                                waLog(`✅ [WA-Pairing] CODE REÇU : ${this.pairingCode}`);
                            } catch (err) {
                                waLog(`⚠️ [WA-Pairing] Échec tentative ${attempt} : ${err.message}`);
                                if (attempt < 3) {
                                    waLog(`[WA-Pairing] Nouvelle tentative dans 10s...`);
                                    setTimeout(() => retryPairing(attempt + 1), 10000);
                                } else {
                                    this.pairingCode = "ERROR: " + err.message;
                                    this._pairingRequested = false; // Permettre de retenter au prochain QR
                                }
                            }
                        };
                        // Petit délai de sécurité (30s) pour éviter d'être flaggé comme spam par Meta
                        setTimeout(() => retryPairing(1), 30000);
                    }
                } catch (err) {
                    console.error('❌ Erreur génération image QR:', err);
                }
            }

            // Suppression de l'ancienne logique setTimeout fixe (remplacée par la méthode Le Relais ci-dessus)

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                this.isActive = false;
                this._isStarting = false; // Libération du lock sur fermeture

                waLog(`[WA] Connexion fermée: ${statusCode}. Reconnexion: ${shouldReconnect}`);

                // [🛡️ STABILITÉ] Si un restart() est en cours, on ne relance PAS ici.
                // C'est restart() qui appellera start() après la purge.
                if (this._restarting) {
                    waLog('[WA] Restart en cours — auto-reconnexion bloquée.');
                    return;
                }

                if (statusCode === DisconnectReason.loggedOut) {
                    waLog('[WA-CRIT] Déconnecté (401)! Nettoyage de la session...');
                    if (this._clearSession) await this._clearSession().catch(() => {});
                    setTimeout(() => this.start(), 2000); 
                } else if (statusCode === 440 || statusCode === 405) {
                    waLog('[WA-STABILITY] Conflit ou erreur 405. Attente 10s avant retry...');
                    setTimeout(() => this.start(), 10000);
                } else if (statusCode === 428) {
                    this._consecutive428 = (this._consecutive428 || 0) + 1;
                    waLog(`[WA-RETRY] Code 428 (#${this._consecutive428})... Pas de purge pour préserver la session.`);
                    
                    // [🛡️ STABILITÉ] On ne purge PLUS sur 428. 428 est une erreur de connexion, pas de session.
                    // On utilise un backoff progressif pour laisser Meta respirer.
                    const delay = Math.min(15000 * this._consecutive428, 60000);
                    waLog(`[WA-RETRY] Attente ${delay/1000}s avant reconnexion...`);
                    setTimeout(() => this.start(), delay);
                } else {
                    waLog(`[WA-RETRY] Tentative de reconnexion immédiate (code ${statusCode})...`);
                    this.start();
                }
            } else if (connection === 'open') {
                waLog('✅ [WA] WhatsApp connecté avec succès !');
                this.isActive = true;
                this._isStarting = false;
                this._consecutive428 = 0; // Reset success
                this._decryptionFailures = 0;
                this._connectedAt = Date.now();
                this.lastQR = null; // Plus besoin du QR une fois connecté
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
                let remoteJid = msg.key.remoteJid;
                const isMe = msg.key.fromMe;
                
                // [🔍 DIAGNOSTIC] Log détaillé pour CHAQUE message reçu
                waLog(`[WA-MSG-RAW] id=${msg.key.id?.substring(0,12)}, fromMe=${isMe}, remoteJid=${remoteJid}, hasMessage=${!!msg.message}, stubType=${msg.messageStubType || 'none'}, msgKeys=${msg.message ? Object.keys(msg.message).join(',') : 'EMPTY'}`);
                
                // [🛡️ RÉSOLUTION LID -> PN]
                // On essaie de convertir le LID en numéro de téléphone si possible via le store ou contacts
                if (remoteJid?.includes('@lid')) {
                    const normalized = jidNormalizedUser ? jidNormalizedUser(remoteJid) : null;
                    if (normalized && !normalized.includes('@lid')) {
                        remoteJid = normalized;
                    } else if (isMe) {
                        const selfJidClean = selfJid?.split(':')[0]?.split('@')[0];
                        remoteJid = selfJidClean + '@s.whatsapp.net';
                    }
                    // Si on n'a pas pu résoudre, on garde le LID mais on ne le transforme pas en FAUX numéro
                }

                // [🛡️ DÉTECTION ÉCHEC DÉCHIFFREMENT]
                if (!msg.message || msg.message?.protocolMessage) {
                    // Ne compter que les messages NON-fromMe comme des vrais échecs de déchiffrement
                    // Les messages fromMe vides sont des ACK/protocol normaux
                    // stubType=2 (CIPHERTEXT) = Le message n'a pas pu être déchiffré
                    const isRealDecryptionFailure = !msg.message && !isMe && (!msg.messageStubType || msg.messageStubType === 2);
                    if (isRealDecryptionFailure) {
                        if (!this._decryptionFailuresMap) this._decryptionFailuresMap = new Map();
                        const fails = (this._decryptionFailuresMap.get(remoteJid) || 0) + 1;
                        this._decryptionFailuresMap.set(remoteJid, fails);
                        
                        waLog(`[WA-WARN] ⚠️ VRAI échec déchiffrement #${fails} de ${remoteJid} (id=${msg.key.id?.substring(0,12)})`);

                        // [🛡️ AUTO-RÉPARATION GLOBALE] 
                        // On force la synchronisation de notre nouvelle clé d'identité en envoyant un message invisible.
                        if (fails === 1 || fails === 3) {
                            waLog(`[WA-FIX] Tentative de forçage de clé Signal pour ${remoteJid}...`);
                            try {
                                // Envoi d'un caractère vide invisible pour forcer la mise à jour de session Signal
                                this.sock.sendMessage(remoteJid, { text: "‎" }).catch(() => {});
                            } catch (e) {}
                        }
                        
                        const gracePeriod = 120000; // 2 minutes
                        const timeSinceConnect = Date.now() - (this._connectedAt || 0);

                        if (fails >= 10 && timeSinceConnect > gracePeriod) {
                            waLog(`[WA-CRIT] Corruption de clés majeure détectée (${fails} échecs). Auto-purge...`);
                            if (this._clearSession) {
                                await this._clearSession().catch(() => {});
                            }
                            setTimeout(() => process.exit(1), 1000);
                            return;
                        }
                    }
                    waLog(`[WA-MSG] SKIP ${isMe ? 'fromMe-' : ''}${msg.messageStubType ? 'stub-' : ''}protocol/empty from ${remoteJid}`);
                    continue;
                }

                // Succès : on remet le compteur à zéro pour ce JID
                if (this._decryptionFailuresMap) this._decryptionFailuresMap.delete(remoteJid);

                const selfJidClean = selfJid?.split(':')[0]?.split('@')[0];
                const remoteJidClean = remoteJid?.split('@')[0].split(':')[0];
                const isMessageToSelf = remoteJidClean === selfJidClean || msg.key.remoteJid?.endsWith('@lid') || msg.key.remoteJid === selfJidClean + '@s.whatsapp.net';

                // Détecter si le message vient d'un BOT (Baileys ou autre bot instance)
                const isBotId = msg.key.id.startsWith('BAE5') || msg.key.id.startsWith('3EB0') || msg.key.id.length > 20;

                waLog(`[WA-MSG] fromMe=${isMe}, isBotId=${isBotId}, remoteJid=${remoteJid}, toSelf=${isMessageToSelf}`);

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
        if (phoneNumber) {
            this.pairingPhone = phoneNumber;
            this.pairingCode = null;
        }

        if (!this.sock || !this.isActive) {
            waLog(`[WA-Pairing] Socket non actif, tentative de démarrage...`);
            await this.initialize();
            await this.start({ pairingPhone: phoneNumber });
        }
        
        // Attendre que le code soit généré par l'event loop (timeout 45s)
        let attempts = 0;
        while (!this.pairingCode && attempts < 45) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        if (!this.pairingCode) throw new Error("Le code n'a pas pu être généré. Vérifiez les logs.");
        return this.pairingCode;
    }

    async stop() {
        if (this.sock) this.sock.end();
        this.isActive = false;
    }

    async restart(options = {}) {
        waLog('[WA] Restart demandé — nettoyage session Supabase et reconnexion...');
        this._restarting = true;
        // 1. Fermer la connexion existante
        if (this.sock) {
            try { this.sock.end(); } catch (e) {}
            this.sock = null;
        }
        this.isActive = false;
        this.pairingCode = null;
        this.pairingPhone = options.pairingPhone || null;

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
        await this.start(options);
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
            // [🛡️ STABILITÉ] Suppression du PresenceUpdate qui peut fragiliser les nouvelles sessions
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
            // Normaliser le JID : ajouter @s.whatsapp.net si absent
            if (jid && !jid.includes('@')) {
                jid = jid + '@s.whatsapp.net';
            }

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

        // [🛡️ NORMALISATION LID]
        let jid = (userId.includes('@')) ? userId : `${userId}@s.whatsapp.net`;
        if (jid.includes('@lid')) jid = jid.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        
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
            if (e.message.includes('SessionError') || e.message.includes('No sessions')) {
                waLog(`[WA-Session-Fix] Tentative de réparation de session pour ${jid}...`);
                // Sur SessionError, on tente un envoi ultra-basique pour "réveiller" Signal
                try {
                    await this.sock.sendMessage(jid, { text: "." }); 
                    const result = await this.sock.sendMessage(jid, { text: textMenu || "Choisissez une option :" });
                    if (result?.key?.id) sentIds.push(result.key.id);
                    return { success: true, sentIds };
                } catch (e2) {
                    waLog(`[WA-Interactive] Échec critique après fix session: ${e2.message}`);
                }
            }
            console.error('[WA-Interactive] Échec envoi texte:', e);
            return { success: false, sentIds, error: e.message };
        }
    }

    _extractText(msg) {
        let m = msg.message;
        // Déballage des messages spécifiques Baileys/WhatsApp
        if (m?.deviceSentMessage?.message) m = m.deviceSentMessage.message;
        if (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message;
        if (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
        if (m?.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
        if (m?.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

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
                    logger: pino({ level: 'info' }),
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
            return s.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        }
        
        // Default to s.whatsapp.net if no suffix
        if (!s.includes('@')) return s + '@s.whatsapp.net';
        
        return s;
    }
}

module.exports = { WhatsAppSessionChannel };
