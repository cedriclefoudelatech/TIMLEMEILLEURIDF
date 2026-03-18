const express = require('express');
const cors = require('cors');
const path = require('path');
const fileUpload = require('express-fileupload');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const {
    getUserCount, getActiveUserCount, getRecentUsers, searchUsers,
    getReferralLeaderboard, getStatsOverview, getDailyStats,
    getProducts, saveProduct, deleteProduct,
    getAllOrders, updateOrderStatus, setLivreurStatus, getOrder, assignOrderLivreur,
    setLivreurAvailability, getAppSettings, updateAppSettings,
    deleteUser, incrementOrderCount, makeDocId, getOrderAnalytics, searchLivreurs,
    getBroadcastHistory, deleteBroadcast, getDetailedLivreurActivity,
    nukeDatabase, decryptUser, supabase, COL_USERS,
    registerUser, getLivreurHistory, getReviews, deleteReview, deleteOrder,
    getSuppliers, getSupplier, saveSupplier, deleteSupplier, getSupplierProducts, getSupplierOrders
} = require('./services/database');
const { broadcastMessage } = require('./services/broadcast');
const fs = require('fs');

function debugLog(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(path.join(process.cwd(), 'debug.log'), line);
    } catch (e) { }
    console.log(msg);
}

// configuration handled in index.js

const { dispatcher } = require('./services/dispatcher');
const { registry } = require('./channels/ChannelRegistry');

// Référence partagée au bot Telegram (définie par index.js)
let _bot = null;
function setBotInstance(bot) { _bot = bot; }
function getBotInstance() { return _bot; }

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.ENCRYPTION_KEY || require('crypto').randomBytes(64).toString('hex');

// Rate limiter : 5 tentatives max par 15 minutes sur le login
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, default: true },
    handler: (req, res, next, options) => {
        console.warn(`[AUTH] Rate limit atteint pour IP: ${req.ip}`);
        res.status(429).json(options.message);
    }
});

function createServer() {
    const app = express();

    // Log all requests for debugging
    app.use((req, res, next) => {
        console.log(`[HTTP] ${req.method} ${req.url} (from ${req.ip})`);
        next();
    });

    console.log(`[System] Initializing server on port: ${process.env.PORT || 3000}`);

    app.use(cors());
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use(fileUpload({
        limits: { fileSize: 50 * 1024 * 1024 },
        useTempFiles: true,
        tempFileDir: '/tmp/'
    }));
    app.use('/public', express.static(path.join(__dirname, 'web', 'public')));

    // Webhook WhatsApp (Cloud API)
    app.post('/api/whatsapp/webhook', async (req, res) => {
        const waChannel = registry.query('whatsapp');
        if (waChannel && waChannel.handleWebhook) {
            await waChannel.handleWebhook(req, res);
        } else {
            res.sendStatus(404);
        }
    });

    app.get('/api/whatsapp/webhook', (req, res) => {
        const waChannel = registry.query('whatsapp');
        if (waChannel && waChannel.handleWebhook) {
            waChannel.handleWebhook(req, res);
        } else {
            res.sendStatus(404);
        }
    });

    // ========== Authentication ==========

    async function authMiddleware(req, res, next) {
        const raw = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
        if (!raw) return res.status(401).json({ error: 'Token manquant' });

        // 1. Essai JWT signé
        try {
            jwt.verify(raw, JWT_SECRET);
            return next();
        } catch (_) {}

        // 2. Rétrocompatibilité : token = mot de passe en clair (ancien comportement)
        // Conservé uniquement pour la migration — supprimé après déploiement stable
        try {
            const settings = await getAppSettings();
            if (raw === settings.admin_password || raw === ADMIN_PASSWORD) {
                return next();
            }
        } catch (_) {}

        console.warn(`[AUTH] Accès refusé — token invalide (IP: ${req.ip})`);
        res.status(401).json({ error: 'Non autorisé' });
    }

    // Health check pour Railway/Debug
    app.get('/_health', (req, res) => {
        res.json({
            status: 'ok',
            time: new Date().toISOString(),
            port: process.env.PORT || 'not-set',
            env: process.env.RAILWAY_ENVIRONMENT || 'local'
        });
    });

    // QR Code WhatsApp - accessible via navigateur pour scanner
    app.get('/whatsapp-qr', (req, res) => {
        const qrPath = path.join(process.cwd(), 'whatsapp_qr.png');
        if (fs.existsSync(qrPath)) {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.sendFile(qrPath);
        } else {
            res.status(404).send('<html><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>QR Code pas encore généré</h1><p>Le bot est en cours de connexion. Rechargez la page dans quelques secondes.</p><script>setTimeout(()=>location.reload(),5000)</script></div></body></html>');
        }
    });

    // WhatsApp restart - nettoie la session et relance le QR
    app.get('/wa-restart', authMiddleware, async (req, res) => {
        try {
            const waSession = registry.query('whatsapp');
            if (waSession && waSession.restart) {
                await waSession.restart();
                res.send('<html><body style="background:#111;color:#0f0;font-family:sans-serif;text-align:center;padding:50px"><h1>WhatsApp redémarré</h1><p>Nouveau QR en cours de génération...</p><script>setTimeout(()=>window.location="/whatsapp-qr",3000)</script></body></html>');
            } else {
                res.status(404).send('WhatsApp Session channel not found');
            }
        } catch (e) {
            res.status(500).send('Error: ' + e.message);
        }
    });

    // WhatsApp connection logs - debug en live
    app.get('/wa-logs', authMiddleware, (req, res) => {
        const { waLogs } = require('./services/wa_log_shared');
        const logs = waLogs;
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(`<html><head><meta http-equiv="refresh" content="3"><style>body{background:#111;color:#0f0;font-family:monospace;padding:20px;font-size:13px}pre{white-space:pre-wrap}</style></head><body><h2 style="color:#fff">WhatsApp Logs (auto-refresh 3s)</h2><pre>${logs.join('\n') || 'Aucun log encore...'}</pre></body></html>`);
    });

    // ========== Static Pages ==========

    app.get('/', (req, res) => {
        console.log('[DEBUG] Root route Hit!');
        res.sendFile(path.join(__dirname, 'web', 'views', 'login.html'));
    });
    app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'dashboard.html')));
    app.get('/address-picker', (req, res) => res.sendFile(path.join(__dirname, 'web', 'views', 'address_picker.html')));


    // ========== API Routes ==========

    app.post('/api/login', loginLimiter, async (req, res) => {
        try {
            const { password } = req.body;
            let settings = {};
            try {
                settings = await getAppSettings();
            } catch (e) {
                console.error('⚠️ getAppSettings() a échoué, fallback sur ADMIN_PASSWORD:', e.message);
            }

            if (password === settings.admin_password || password === ADMIN_PASSWORD) {
                // Émet un JWT signé valable 12h — le mot de passe ne transite plus dans les requêtes
                const token = jwt.sign(
                    { role: 'admin', iat: Math.floor(Date.now() / 1000) },
                    JWT_SECRET,
                    { expiresIn: '12h' }
                );
                console.log(`[AUTH] Login admin réussi (IP: ${req.ip})`);
                res.json({ success: true, token });
            } else {
                console.warn(`[AUTH] Échec login (IP: ${req.ip})`);
                res.status(401).json({ error: 'Mot de passe incorrect' });
            }
        } catch (e) {
            console.error('❌ Erreur login:', e.message);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.post('/api/forgot-password', async (req, res) => {
        try {
            const settings = await getAppSettings();
            const bot = getBotInstance();
            if (!bot) return res.status(500).json({ error: 'Bot non initialisé' });

            const adminIds = String(settings.admin_telegram_id || '').split(/[\s,]+/).map(id => id.trim().replace('telegram_', ''));
            const alertMsg = `⚠️ <b>RÉCUPÉRATION DE COMPTE</b>\n\nUne demande de réinitialisation du mot de passe a été faite depuis le Dashboard.\n\nSouhaitez-vous modifier le mot de passe d'administration ?`;
            const keyboard = {
                inline_keyboard: [[{ text: '🔄 Modifier le mot de passe', callback_data: 'admin_trigger_password_reset' }]]
            };

            for (const adminId of adminIds) {
                if (adminId) bot.telegram.sendMessage(adminId, alertMsg, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => { });
            }

            res.json({ success: true, message: 'Notification envoyée aux administrateurs.' });
        } catch (e) {
            console.error('Forgot password error:', e.message);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.get('/api/stats', authMiddleware, async (req, res) => {
        try { res.json(await getStatsOverview()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/stats/daily', authMiddleware, async (req, res) => {
        try { res.json(await getDailyStats(parseInt(req.query.days) || 30)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/users', authMiddleware, async (req, res) => {
        try { res.json(await getRecentUsers(parseInt(req.query.limit) || 50)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/users/search', authMiddleware, async (req, res) => {
        try { res.json(await searchUsers(req.query.q)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/delete', authMiddleware, async (req, res) => {
        try {
            await deleteUser(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/add', authMiddleware, async (req, res) => {
        try {
            const { telegram_id, first_name, username } = req.body;

            // Nettoyage de l'ID (on enlève le préfixe si l'admin l'a mis par erreur)
            const cleanId = String(telegram_id || '').replace('telegram_', '').trim();
            if (!cleanId) return res.status(400).json({ error: 'ID Telegram manquant ou invalide' });

            const { user, isNew } = await registerUser({
                id: cleanId,
                first_name: first_name || 'Utilisateur Manuel',
                username: username || '',
                type: 'user'
            });

            res.json({ success: true, user, isNew });
        } catch (e) {
            console.error('Add user error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/users/block', authMiddleware, async (req, res) => {
        try {
            const { markUserBlocked } = require('./services/database');
            await markUserBlocked(req.body.id, true);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/check-status', authMiddleware, async (req, res) => {
        try {
            const { getUser, markUserBlocked, markUserUnblocked } = require('./services/database');
            const u = await getUser(req.body.id);
            if (!u || !u.platform_id) return res.json({ success: false, error: 'User introuvable' });

            try {
                const bot = getBotInstance();
                if (!bot) return res.status(500).json({ error: 'Bot non initialisé' });

                // On tente une petite action "typing" pour voir si le bot est bloqué
                const chatId = u.platform_id.replace('telegram_', '');
                await bot.telegram.sendChatAction(chatId, 'typing');

                // Si ça réussit et qu'il était marqué bloqué par le client, on le débloque
                if (u.is_blocked && u.data && u.data.blocked_by_admin === false) {
                    await markUserUnblocked(u.id);
                }
                res.json({ success: true, status: 'active' });
            } catch (err) {
                const desc = err.description || '';
                if (err.code === 403 || desc.includes('blocked') || desc.includes('chat not found')) {
                    await markUserBlocked(u.id, false);
                    return res.json({ success: true, status: 'blocked' });
                }
                throw err;
            }
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/users/unblock', authMiddleware, async (req, res) => {
        try {
            const { markUserUnblocked } = require('./services/database');
            await markUserUnblocked(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/users/order', authMiddleware, async (req, res) => {
        try {
            await incrementOrderCount(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ========== Product Routes ==========

    app.get('/api/products', authMiddleware, async (req, res) => {
        try { res.json(await getProducts()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/products', authMiddleware, async (req, res) => {
        try {
            const id = await saveProduct(req.body);
            res.json({ success: true, id });
        } catch (e) {
            console.error('Product save error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/products/:id', authMiddleware, async (req, res) => {
        try {
            await deleteProduct(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ========== Order Routes ==========

    app.get('/api/orders', authMiddleware, async (req, res) => {
        try { res.json(await getAllOrders(parseInt(req.query.limit) || 100)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
        try {
            const { deleteOrder } = require('./services/database');
            await deleteOrder(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/analytics', authMiddleware, async (req, res) => {
        try { res.json(await getOrderAnalytics()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ========== Upload Routes ==========
    app.post('/api/upload', authMiddleware, async (req, res) => {
        try {
            if (!req.files || !req.files.file) {
                return res.status(400).json({ error: 'Aucun fichier téléchargé' });
            }

            const file = req.files.file;
            const ext = path.extname(file.name) || (file.mimetype.includes('video') ? '.mp4' : '.jpg');
            const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;

            debugLog(`[UPLOAD] Upload Supabase Storage: ${fileName} (${file.mimetype}, size=${file.size})`);

            // Upload direct vers Supabase Storage (seule source de vérité — pas de fallback local)
            const { supabase } = require('./config/supabase');
            // Avec useTempFiles: true, file.data peut être vide — lire depuis le fichier temp
            let fileBuf = file.data;
            if ((!fileBuf || fileBuf.length === 0) && file.tempFilePath) {
                fileBuf = fs.readFileSync(file.tempFilePath);
                debugLog(`[UPLOAD] Read from tempFile: ${file.tempFilePath} (${fileBuf.length} bytes)`);
            }
            if (!fileBuf || fileBuf.length === 0) {
                debugLog(`[UPLOAD-FAIL] Buffer vide pour ${file.name}`);
                return res.status(400).json({ error: 'Fichier vide — upload impossible' });
            }

            const { error } = await supabase.storage
                .from('uploads')
                .upload(fileName, fileBuf, {
                    contentType: file.mimetype,
                    upsert: true
                });

            if (error) {
                debugLog(`[UPLOAD-FAIL] Supabase Storage: ${error.message}`);
                return res.status(500).json({ error: `Upload échoué: ${error.message}` });
            }

            const { data: publicData } = supabase.storage.from('uploads').getPublicUrl(fileName);
            const finalUrl = publicData.publicUrl;
            debugLog(`[UPLOAD-OK] ${finalUrl} (${fileBuf.length} bytes)`);

            // Nettoyage du fichier temp
            if (file.tempFilePath) {
                fs.unlink(file.tempFilePath, () => {});
            }

            res.json({ success: true, url: finalUrl });
        } catch (e) {
            debugLog(`[UPLOAD-FATAL] ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/debug/dir', authMiddleware, async (req, res) => {
        try {
            const dir = path.resolve(__dirname, 'web', 'public', 'uploads');
            if (!fs.existsSync(dir)) return res.send('Répertoire inexistant.');
            const files = fs.readdirSync(dir);
            res.json({ dir, files });
        } catch (e) { res.status(500).send(e.message); }
    });

    app.get('/api/debug/logs', authMiddleware, async (req, res) => {
        try {
            const logPath = path.join(process.cwd(), 'debug.log');
            if (!fs.existsSync(logPath)) return res.send('Aucun log trouvé.');
            const content = fs.readFileSync(logPath, 'utf8');
            res.header('Content-Type', 'text/plain');
            res.send(content);
        } catch (e) { res.status(500).send(e.message); }
    });

    app.post('/api/users/wallet', authMiddleware, async (req, res) => {
        const { userId, amount } = req.body;
        try {
            const { updateUserWallet } = require('./services/database');
            await updateUserWallet(userId, amount);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/users/points', authMiddleware, async (req, res) => {
        const { userId, points } = req.body;
        try {
            const { updateUserPoints } = require('./services/database');
            await updateUserPoints(userId, points);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/livreurs/status', authMiddleware, async (req, res) => {
        const { userId, platform, isLivreur } = req.body;
        try {
            await setLivreurStatus(userId, platform, isLivreur);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/livreurs/search', authMiddleware, async (req, res) => {
        try { res.json(await searchLivreurs(req.query.q)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/livreurs/availability', authMiddleware, async (req, res) => {
        const { platform, userId, isAvailable, id: directId } = req.body;
        try {
            const docId = directId || makeDocId(platform, userId);
            await setLivreurAvailability(docId, isAvailable);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/admin/nuke', authMiddleware, async (req, res) => {
        try {
            debugLog(`[ADMIN] NUKE DATABASE REQUESTED BY ${req.user?.platform_id || 'unidentified'}`);
            await nukeDatabase();
            res.json({ success: true, message: 'Base de données réinitialisée.' });
        } catch (e) {
            debugLog(`[ADMIN-FATAL] Nuke failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/livreurs', authMiddleware, async (req, res) => {
        try {
            const { data } = await supabase.from(COL_USERS).select('*').eq('is_livreur', true);
            const livreurs = (data || []).map(d => {
                try { return decryptUser({ ...d, doc_id: d.id }); }
                catch (e) {
                    console.error('Decryption failed for livreur:', d.id, e.message);
                    return { ...d, doc_id: d.id };
                }
            });
            res.json(livreurs);
        } catch (e) { console.error('Livreurs API error:', e); res.status(500).json({ error: e.message }); }
    });

    app.get('/api/livreurs/:id/history', authMiddleware, async (req, res) => {
        try {
            const history = await getDetailedLivreurActivity(req.params.id);
            res.json(history);
        } catch (e) {
            console.error('Livreur history error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/settings', authMiddleware, async (req, res) => {
        try { res.json(await getAppSettings()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/settings', authMiddleware, async (req, res) => {
        try {
            const updates = { ...req.body };
            if (!updates.admin_password || updates.admin_password.trim() === '') {
                delete updates.admin_password;
            }
            await updateAppSettings(updates);
            res.json({ success: true });
        } catch (e) {
            console.error('❌ Settings update error:', e);
            res.status(500).json({ error: e.message || 'Erreur serveur' });
        }
    });

    app.post('/api/orders/status', authMiddleware, async (req, res) => {
        try {
            const { orderId, status } = req.body;
            const order = await getOrder(orderId);
            if (!order) return res.status(404).json({ error: 'Commande non trouvée' });

            await updateOrderStatus(orderId, status);

            // Notification Client Automatisée
            if (order.user_id) {
                const { sendMessageToUser } = require('./services/notifications');
                const settings = await getAppSettings();
                const shortId = orderId.slice(-5);
                
                const statusLabel = (status === 'delivered' ? settings.status_delivered_label :
                    (status === 'pending' ? settings.status_pending_label :
                        (status === 'taken' ? settings.status_taken_label : settings.status_cancelled_label))) || status.toUpperCase();

                const statusIcon = (status === 'delivered' ? settings.ui_icon_success :
                    (status === 'pending' ? settings.ui_icon_pending :
                        (status === 'taken' ? (settings.ui_icon_taken || '🚚') : settings.ui_icon_error))) || '🔔';

                let text = '';
                switch (status) {
                    case 'validated':
                        text = `✅ <b>COMMANDE VALIDÉE !</b>\n\nVotre commande #${shortId} a été acceptée. Un livreur va être assigné.`;
                        break;
                    case 'refused':
                    case 'cancelled':
                        text = `${settings.ui_icon_error} <b>COMMANDE ${statusLabel}</b>\n\nVotre commande #${shortId} a été annulée.`;
                        break;
                    case 'delivering':
                    case 'taken':
                        text = `${statusIcon} <b>COMMANDE EN ROUTE !</b>\n\nVotre commande #${shortId} est en cours de livraison. Un livreur a pris en charge votre commande et arrive vers vous. 💨`;
                        break;
                    case 'delivered':
                        text = `${statusIcon} <b>COMMANDE LIVRÉE !</b>\n\nVotre commande #${shortId} a été livrée. Bonne dégustation ! 🏁`;
                        break;
                    case 'arrival_1h':
                        text = `🚚 <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>moins d'une heure</b>. 📦`;
                        break;
                    case 'arrival_30min':
                        text = `⏳ <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>30 min</b> ! Soyez prêt(e). 🛵`;
                        break;
                    case 'arrival_10min':
                        text = `⏳ <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>10 min</b> ! Préparez-vous. 🛵`;
                        break;
                    case 'arrival_5min':
                        text = `⚡ <b>Commande #${shortId}</b>\n\nVotre livreur arrive dans <b>5 min</b> ! Soyez prêt(e). 🔥`;
                        break;
                    case 'arrived':
                        text = `📍 <b>Commande #${shortId}</b>\n\n<b>Votre livreur est arrivé !</b> Il vous attend sur place. ✅`;
                        break;
                    case 'cancelled':
                        text = `${settings.ui_icon_error} <b>${statusLabel} de commande</b>\n\nVotre commande #${shortId} a été annulée par l'administration.`;
                        break;
                    case 'pending':
                        text = `${settings.ui_icon_pending} <b>Mise à jour de commande</b>\n\nVotre commande #${shortId} est de nouveau ${statusLabel}.`;
                        break;
                }
                
                if (text) {
                    const { Markup } = require('telegraf');
                    let keyboard = [];

                    // Ajouter bouton annulation si pas encore livré ou annulé
                    if (!['delivered', 'cancelled', 'refused'].includes(status)) {
                        keyboard.push([Markup.button.callback('❌ Annuler ma commande', `cancel_order_client_${orderId}`)]);
                        // Si c'est une notification de temps, permettre de répondre
                        if (status.startsWith('arrival_')) {
                            keyboard.push([Markup.button.callback('💬 Répondre au livreur', `chat_livreur_${orderId}`)]);
                        }
                    } else if (status === 'delivered') {
                        keyboard.push([Markup.button.callback('⭐️ Laisser un avis', `feedback_start_${orderId}`)]);
                    }

                    keyboard.push([Markup.button.callback('◀️ Retour Menu', 'main_menu')]);

                    await sendMessageToUser(order.user_id, text, {
                        reply_markup: Markup.inlineKeyboard(keyboard).reply_markup
                    }).catch(() => {});
                }
            }

            res.json({ success: true });
        } catch (e) {
            console.error('Order Status API error:', e);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.post('/api/orders/assign', authMiddleware, async (req, res) => {
        try {
            const { orderId, livreurId, livreurName } = req.body;
            const { assignOrderLivreur } = require('./services/database');
            await assignOrderLivreur(orderId, livreurId, livreurName);

            // Notification
            const order = await getOrder(orderId);
            if (order && order.user_id) {
                const { sendMessageToUser } = require('./services/notifications');
                const text = `🚚 <b>Votre commande #${orderId.slice(-5)} est prise en charge !</b>\n\nLe livreur <b>${livreurName}</b> arrive vers vous. 💨`;
                await sendMessageToUser(order.user_id, text).catch(() => { });
            }
            res.json({ success: true });
        } catch (e) {
            console.error('Order Assign API error:', e);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    app.post('/api/orders/delete', authMiddleware, async (req, res) => {
        try {
            await deleteOrder(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    /**
     * Broadcast - accepte FormData avec fichiers médias
     */
    app.post('/api/broadcast', authMiddleware, async (req, res) => {
        try {
            const message = req.body.message || '';
            const platform = req.body.platform || 'all';
            const mediaCount = parseInt(req.body.media_count) || 0;

            // Extraire les fichiers médias
            const mediaFiles = [];
            if (req.files) {
                const fs = require('fs');
                debugLog(`[API-BC] Reçu de ${mediaCount} fichiers attendus.`);
                for (let i = 0; i < mediaCount; i++) {
                    const f = req.files[`media_${i}`];
                    if (f) {
                        try {
                            const fileData = f.tempFilePath ? fs.readFileSync(f.tempFilePath) : f.data;
                            if (fileData && fileData.length > 0) {
                                mediaFiles.push({ data: fileData, mimetype: f.mimetype, name: f.name });
                                debugLog(`[API-BC] Fichier ${i} prêt: ${f.name} (${f.mimetype}, ${fileData.length} octets)`);
                            }
                        } catch (err) {
                            debugLog(`[API-BC-ERR] Lecture fichier ${i}: ${err.message}`);
                        }
                    } else {
                        debugLog(`[API-BC-WARN] media_${i} manquant dans req.files`);
                    }
                }
            }

            let mediaUrls = [];
            try { mediaUrls = req.body.media_urls ? JSON.parse(req.body.media_urls) : []; } catch (e) { mediaUrls = []; }

            if (!message && mediaFiles.length === 0 && mediaUrls.length === 0) {
                return res.status(400).json({ error: 'Message ou média requis' });
            }

            debugLog(`[API-BC-OK] Lancement: "${message.substring(0, 20)}..." Platform: ${platform}, Médias: ${mediaFiles.length}, URLs: ${mediaUrls.length}`);
            res.json({ status: 'started', media_count: mediaFiles.length + mediaUrls.length });

            const start_at = req.body.start_at || new Date().toISOString();
            const end_at = req.body.end_at || null;
            const badge = req.body.badge || null;

            // Lancer la diffusion
            broadcastMessage(platform, message, {
                mediaFiles,
                mediaUrls,
                start_at,
                end_at,
                badge,
                poll_options: req.body.poll_options || null,
                poll_allow_free: req.body.poll_allow_free === 'true' || req.body.poll_allow_free === true
            }).catch(err => {
                debugLog(`[API-BC-FATAL] ${err.message}`);
            });
        } catch (e) {
            debugLog(`[API-BC-CRITICAL] ${e.message}`);
            res.status(500).json({ error: 'Erreur broadcast' });
        }
    });

    app.get('/api/broadcasts', authMiddleware, async (req, res) => {
        try { res.json(await getBroadcastHistory()); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.get('/api/reviews', authMiddleware, async (req, res) => {
        try { res.json(await getReviews(parseInt(req.query.limit) || 100)); }
        catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.post('/api/reviews/delete', authMiddleware, async (req, res) => {
        try {
            await deleteReview(req.body.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    app.delete('/api/broadcasts/:id', authMiddleware, async (req, res) => {
        try {
            await deleteBroadcast(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
    });

    // ====== SUPPLIERS / FOURNISSEURS ======
    app.get('/api/suppliers', authMiddleware, async (req, res) => {
        try { res.json(await getSuppliers()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/suppliers/:id', authMiddleware, async (req, res) => {
        try { res.json(await getSupplier(req.params.id)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/suppliers', authMiddleware, async (req, res) => {
        try {
            const result = await saveSupplier(req.body);
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/suppliers/:id', authMiddleware, async (req, res) => {
        try {
            await deleteSupplier(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/suppliers/:id/products', authMiddleware, async (req, res) => {
        try { res.json(await getSupplierProducts(req.params.id)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/suppliers/:id/orders', authMiddleware, async (req, res) => {
        try { res.json(await getSupplierOrders(req.params.id)); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.use('/api/*', (req, res) => {
        res.status(404).json({ error: 'Route API non trouvée' });
    });

    // Global error handler for Express
    app.use((err, req, res, next) => {
        console.error('❌ [EXPRESS ERROR]', err);
        res.status(500).json({ error: 'Erreur interne du serveur' });
    });

    return app;
}

module.exports = { createServer, setBotInstance };
