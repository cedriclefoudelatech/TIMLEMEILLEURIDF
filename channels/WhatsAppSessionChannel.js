let Baileys;
let makeWASocket;
let useMultiFileAuthState, DisconnectReason, jidDecode, fetchLatestBaileysVersion, downloadMediaMessage;

async function loadBaileys() {
    if (Baileys) return;
    const mod = await import('@whiskeysockets/baileys');
    
    // Check all possible places
    console.log('[WA-Debug] Root keys count:', Object.keys(mod).length);
    if (mod.default) console.log('[WA-Debug] Default keys count:', Object.keys(mod.default).length);
    
    // Find where the exported functions are
    let target = null;
    if (mod.useMultiFileAuthState) {
        target = mod;
    } else if (mod.default && mod.default.useMultiFileAuthState) {
        target = mod.default;
    } else {
        // Fallback to searching in all keys if necessary or using the root
        target = mod;
    }
    
    Baileys = target;
    makeWASocket = target.default || target;
    useMultiFileAuthState = target.useMultiFileAuthState;
    DisconnectReason = target.DisconnectReason;
    jidDecode = target.jidDecode;
    fetchLatestBaileysVersion = target.fetchLatestBaileysVersion;
    downloadMediaMessage = target.downloadMediaMessage;
    
    console.log('[WA-Debug] useMultiFileAuthState type:', typeof useMultiFileAuthState);
}


const { Channel } = require('./Channel');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode');



class WhatsAppSessionChannel extends Channel {
    constructor(config) {
        super('whatsapp', 'WhatsApp (Session)');
        this.sessionId = config.sessionId || 'default';
        this.pairingNumber = config.pairingNumber || null;
        this.authFolder = path.resolve(process.cwd(), 'sessions', this.sessionId);
        this.sock = null;
        this.messageHandler = null;
        this.store = null; 
    }

    async initialize() {
        await loadBaileys();
        const sessionsDir = path.join(process.cwd(), 'sessions');
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }
        // Nettoyer les sessions corrompues (creds sans registered = échec précédent)
        const credsPath = path.join(this.authFolder, 'creds.json');
        if (fs.existsSync(credsPath)) {
            try {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                if (!creds.registered) {
                    console.log('[WA] Session non enregistrée détectée, nettoyage...');
                    fs.rmSync(this.authFolder, { recursive: true, force: true });
                    fs.mkdirSync(this.authFolder, { recursive: true });
                }
            } catch (e) {
                console.log('[WA] Session corrompue, nettoyage...');
                fs.rmSync(this.authFolder, { recursive: true, force: true });
                fs.mkdirSync(this.authFolder, { recursive: true });
            }
        }
        console.log(`[WA-Session] QR mode for: ${this.sessionId}`);
        console.log(`[WA-Session] 📱 QR code sera disponible sur: /whatsapp-qr`);
    }

    async start() {
        const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WA] Using version v${version.join('.')}, isLatest: ${isLatest}`);

        this.sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['TIM', 'Chrome', '121.0.6167.85'], // Plus moderne
            printQRInTerminal: false
        });

        // Request pairing code if requested and not registered
        if (this.pairingNumber && !this.sock.authState.creds.registered) {
            const cleanNumber = this.pairingNumber.replace(/\D/g, '');
            console.log(`[WA] Requesting pairing code for ${cleanNumber}...`);
            setTimeout(async () => {
                try {
                    const code = await this.sock.requestPairingCode(cleanNumber);
                    console.log('\n--------------------------------------------------');
                    console.log('🔑 VOTRE NOUVEAU CODE DE CONNEXION WHATSAPP :');
                    console.log(`👉 ${code}`);
                    console.log('--------------------------------------------------\n');
                } catch (err) {
                    console.error('❌ Erreur lors de la requête du code:', err.message);
                }
            }, 5000); // Augmenté un peu pour laisser la connexion se stabiliser
        }


        // this.store.bind(this.sock.ev); // Removed store bind

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            console.log('[WA] Connection Update:', { connection, hasQr: !!qr });
            
            if (qr) {
                console.log('--------------------------------------------------');
                console.log('👉 SCANNEZ CE QR CODE POUR CONNECTER WHATSAPP :');
                qrcodeTerminal.generate(qr, { small: true });
                console.log('--------------------------------------------------');
                
                // Sauvegarder en image pour l'utilisateur
                try {
                    // Utiliser le dossier actuel pour éviter les erreurs de chemin absolu
                    const artifactPath = path.join(process.cwd(), 'whatsapp_qr.png');
                    await qrcodeImage.toFile(artifactPath, qr, {
                        color: { dark: '#000000', light: '#ffffff' },
                        width: 512
                    });
                    console.log(`✅ QR Image générée localement: ${artifactPath}`);
                    
                    // Tentative de copie vers l'endroit où Gemini l'attend si on est en local
                    const brainId = '177236d7-8641-49f3-863f-68b583062a32';
                    const geminiPath = `/Users/dikenson/.gemini/antigravity/brain/${brainId}/whatsapp_qr.png`;
                    if (fs.existsSync(path.dirname(geminiPath))) {
                        fs.copyFileSync(artifactPath, geminiPath);
                        console.log(`✅ QR Image copiée pour l'interface: ${geminiPath}`);
                    }
                } catch (err) {
                    console.error('❌ Erreur génération image QR:', err.message);
                }
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                const errorMsg = error?.message || error?.output?.payload?.message || '';
                console.log('[WA] Connexion fermée. Erreur:', errorMsg, 'Code:', statusCode);

                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isQrTimeout = errorMsg.includes('QR refs attempts ended') || statusCode === 408;

                if (isLoggedOut) {
                    console.log('[WA] Déconnecté (loggedOut). Nettoyage session...');
                    fs.rmSync(this.authFolder, { recursive: true, force: true });
                    fs.mkdirSync(this.authFolder, { recursive: true });
                }

                if (!isLoggedOut) {
                    // Si QR timeout, nettoyer la session non-enregistrée avant de réessayer
                    if (isQrTimeout) {
                        console.log('[WA] QR expiré. Nettoyage et nouvelle tentative dans 5s...');
                        const credsPath = path.join(this.authFolder, 'creds.json');
                        if (fs.existsSync(credsPath)) {
                            try {
                                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                                if (!creds.registered) {
                                    fs.rmSync(this.authFolder, { recursive: true, force: true });
                                    fs.mkdirSync(this.authFolder, { recursive: true });
                                }
                            } catch (e) {
                                fs.rmSync(this.authFolder, { recursive: true, force: true });
                                fs.mkdirSync(this.authFolder, { recursive: true });
                            }
                        }
                        setTimeout(() => this.start(), 5000);
                    } else {
                        console.log('[WA] Reconnexion dans 3s...');
                        setTimeout(() => this.start(), 3000);
                    }
                }
            } else if (connection === 'open') {
                console.log('✅ [WA] WhatsApp connecté avec succès !');
                this.isActive = true;
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
                const isMessageToSelf = remoteJidClean === selfJidClean || remoteJid?.endsWith('@lid');
                
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
                
                // Extraction média (Image)
                let photo = null;
                const msgContent = msg.message;
                if (msgContent?.imageMessage) {
                    photo = [{ file_id: msg.key.id, isWa: true, msg: msg }]; 
                }

                if (this.messageHandler && (text || photo)) {
                    console.log(`[WA-In] Text: "${text}" | Photo: ${!!photo} | Action: ${isAction} | From: ${remoteJid}`);
                    await this.messageHandler({
                        from: remoteJid,
                        name: name,
                        text: text,
                        photo: photo,
                        type: photo ? 'photo' : 'text',
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

    onMessage(handler) { this.messageHandler = handler; }

    async sendMessage(userId, text, options = {}) {
        if (!this.sock || !this.isActive) return { success: false, error: 'Not connected' };
        
        // Sécurité JID: on s'assure que l'ID a le bon suffixe si c'est un pur numéro
        const jid = (userId.includes('@')) ? userId : `${userId}@s.whatsapp.net`;
        const cleanText = this._stripHTML(text);
        
        try {
            let result;
            if (options.media_url) {
                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                result = await this.sock.sendMessage(jid, {
                    [mediaType]: { url: options.media_url },
                    caption: cleanText
                });
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
        if (!this.sock || !this.isActive) return;
        
        const jid = (userId.includes('@')) ? userId : `${userId}@s.whatsapp.net`;
        const sentIds = [];
        console.log(`[WA-Interactive] To: ${jid}, Buttons: ${buttons.length}, HasMedia: ${!!options.media_url}`);

        try {
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

            // 1. Envoi combiné (Média + Texte/Menu)
            if (options.media_url) {
                const mediaType = options.media_type === 'video' ? 'video' : 'image';
                const result = await this.sock.sendMessage(jid, {
                    [mediaType]: { url: options.media_url },
                    caption: textMenu || ""
                });
                if (result?.key?.id) sentIds.push(result.key.id);
            } else {
                // 2. Envoi Texte seul (Menu inclus)
                const result = await this.sock.sendMessage(jid, { text: textMenu || "Choisissez une option :" });
                if (result?.key?.id) sentIds.push(result.key.id);
            }
            
            return { success: true, sentIds };
        } catch (e) {
            console.error('[WA-Interactive] Multi-send failed:', e);
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
        if (s.includes('@s.whatsapp.net')) {
            return s.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        }
        if (s.includes('@lid')) {
            return s.split(':')[0].split('@')[0] + '@lid';
        }
        return s;
    }
}

module.exports = { WhatsAppSessionChannel };
