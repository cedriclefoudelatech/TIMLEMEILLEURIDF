/**
 * Script de test des notifications — Envoie des messages test à :
 * 1. L'admin (via notifyAdmins)
 * 2. Tous les livreurs (via notifyLivreurs)
 * 3. L'admin directement via Telegram API
 *
 * Usage: node test_notifications.js
 */

require('dotenv').config();
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN manquant dans .env');
    process.exit(1);
}
if (!ADMIN_ID) {
    console.error('❌ ADMIN_TELEGRAM_ID manquant dans .env');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// On va simuler le registre et les fonctions de notification
const { registry } = require('./channels/ChannelRegistry');
const { getAppSettings, getAllLivreurs } = require('./services/database');

// Enregistrer un faux canal Telegram dans le registre pour que getTgBot() fonctionne
registry.register({
    type: 'telegram',
    name: 'Telegram (Test)',
    isActive: true,
    getBotInstance: () => bot
});

// Maintenant on peut importer les notifications (elles utilisent le registre)
const { notifyAdmins, notifyLivreurs, sendMessageToUser } = require('./services/notifications');

// Aussi setter le bot dans server.js pour le fallback
try {
    const server = require('./server');
    if (server.setBotInstance) server.setBotInstance(bot);
} catch (e) {
    console.warn('⚠️ Impossible de charger server.js (normal en mode test):', e.message);
}

const timestamp = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

async function runTests() {
    console.log('═══════════════════════════════════════');
    console.log('  🧪 TEST DES NOTIFICATIONS');
    console.log(`  📅 ${timestamp}`);
    console.log('═══════════════════════════════════════\n');

    const results = [];

    // ── TEST 1: Envoi direct à l'admin via Telegram API ──
    console.log('📨 TEST 1: Envoi direct à l\'admin via bot.telegram.sendMessage...');
    try {
        await bot.telegram.sendMessage(ADMIN_ID,
            `🧪 <b>TEST 1 — Message Direct</b>\n\n` +
            `✅ Ce message est envoyé directement via l'API Telegram.\n` +
            `📅 ${timestamp}\n\n` +
            `<i>Si vous voyez ce message, l'API Telegram fonctionne.</i>`,
            { parse_mode: 'HTML' }
        );
        results.push({ test: 'Direct Telegram API → Admin', status: '✅ OK' });
        console.log('  ✅ Envoyé avec succès !\n');
    } catch (e) {
        results.push({ test: 'Direct Telegram API → Admin', status: `❌ ÉCHEC: ${e.message}` });
        console.error('  ❌ Échec:', e.message, '\n');
    }

    // ── TEST 2: notifyAdmins (via le service notifications.js) ──
    console.log('📨 TEST 2: notifyAdmins() via notifications.js...');
    try {
        await notifyAdmins(bot,
            `🧪 <b>TEST 2 — notifyAdmins()</b>\n\n` +
            `✅ Ce message est envoyé via la fonction notifyAdmins().\n` +
            `📅 ${timestamp}\n\n` +
            `<i>Si vous voyez ce message, notifyAdmins() fonctionne correctement.</i>`
        );
        results.push({ test: 'notifyAdmins() → Admin', status: '✅ OK' });
        console.log('  ✅ Envoyé avec succès !\n');
    } catch (e) {
        results.push({ test: 'notifyAdmins() → Admin', status: `❌ ÉCHEC: ${e.message}` });
        console.error('  ❌ Échec:', e.message, '\n');
    }

    // ── TEST 3: notifyAdmins SANS bot (fallback registre uniquement) ──
    console.log('📨 TEST 3: notifyAdmins() sans bot (fallback registre)...');
    try {
        await notifyAdmins(
            `🧪 <b>TEST 3 — notifyAdmins() sans bot</b>\n\n` +
            `✅ Ce message est envoyé via notifyAdmins() avec un seul argument (message).\n` +
            `📅 ${timestamp}\n\n` +
            `<i>Si vous voyez ce message, le fallback du registre fonctionne.</i>`
        );
        results.push({ test: 'notifyAdmins(message) fallback', status: '✅ OK' });
        console.log('  ✅ Envoyé avec succès !\n');
    } catch (e) {
        results.push({ test: 'notifyAdmins(message) fallback', status: `❌ ÉCHEC: ${e.message}` });
        console.error('  ❌ Échec:', e.message, '\n');
    }

    // ── TEST 4: sendMessageToUser vers l'admin (avec préfixe telegram_) ──
    console.log('📨 TEST 4: sendMessageToUser() vers admin avec préfixe telegram_...');
    try {
        await sendMessageToUser(`telegram_${ADMIN_ID}`,
            `🧪 <b>TEST 4 — sendMessageToUser(telegram_ID)</b>\n\n` +
            `✅ Ce message est envoyé via sendMessageToUser() avec le préfixe.\n` +
            `📅 ${timestamp}\n\n` +
            `<i>Si vous voyez ce message, sendMessageToUser() gère bien le préfixe.</i>`
        );
        results.push({ test: 'sendMessageToUser(telegram_ID) → Admin', status: '✅ OK' });
        console.log('  ✅ Envoyé avec succès !\n');
    } catch (e) {
        results.push({ test: 'sendMessageToUser(telegram_ID) → Admin', status: `❌ ÉCHEC: ${e.message}` });
        console.error('  ❌ Échec:', e.message, '\n');
    }

    // ── TEST 5: Vérification des settings admin_telegram_id ──
    console.log('📨 TEST 5: Vérification admin_telegram_id dans les settings DB...');
    try {
        const settings = await getAppSettings();
        const dbAdminId = settings?.admin_telegram_id;
        const envAdminId = process.env.ADMIN_TELEGRAM_ID;
        console.log(`  📋 DB admin_telegram_id = "${dbAdminId}"`);
        console.log(`  📋 ENV ADMIN_TELEGRAM_ID = "${envAdminId}"`);

        if (!dbAdminId && !envAdminId) {
            results.push({ test: 'Settings admin_telegram_id', status: '⚠️ VIDE dans DB et ENV !' });
            console.log('  ⚠️ ATTENTION: admin_telegram_id est vide partout !\n');
        } else {
            results.push({ test: 'Settings admin_telegram_id', status: `✅ DB="${dbAdminId}" ENV="${envAdminId}"` });
            console.log('  ✅ Configuration trouvée !\n');
        }
    } catch (e) {
        results.push({ test: 'Settings admin_telegram_id', status: `❌ ÉCHEC: ${e.message}` });
        console.error('  ❌ Échec:', e.message, '\n');
    }

    // ── TEST 6: Notification livreurs ──
    console.log('📨 TEST 6: Récupération et notification de tous les livreurs...');
    try {
        const livreurs = await getAllLivreurs();
        console.log(`  📋 ${livreurs.length} livreur(s) trouvé(s) dans la DB:`);

        for (const l of livreurs) {
            const status = l.is_available ? '🟢 Dispo' : '🔴 Indispo';
            console.log(`    - ${l.first_name || 'Inconnu'} (${l.id}) ${status}`);
        }

        if (livreurs.length === 0) {
            results.push({ test: 'Notification Livreurs', status: '⚠️ Aucun livreur en DB' });
            console.log('  ⚠️ Aucun livreur trouvé !\n');
        } else {
            // Envoyer la notification test à TOUS les livreurs (même indisponibles pour le test)
            let sent = 0;
            let failed = 0;
            for (const l of livreurs) {
                try {
                    await sendMessageToUser(l.id,
                        `🧪 <b>TEST 6 — Notification Livreur</b>\n\n` +
                        `📦 <b>COMMANDE TEST</b>\n` +
                        `📍 Adresse : 123 Rue du Test, 75001 Paris\n` +
                        `💰 Total : <b>25.00€</b> (💵 Espèces)\n\n` +
                        `<i>⚠️ Ceci est un TEST. Pas de vraie commande.</i>\n` +
                        `📅 ${timestamp}`,
                        {}
                    );
                    sent++;
                    console.log(`    ✅ → ${l.first_name || l.id} : envoyé`);
                } catch (e) {
                    failed++;
                    console.log(`    ❌ → ${l.first_name || l.id} : ${e.message}`);
                }
            }
            results.push({ test: `Notification Livreurs (${livreurs.length} total)`, status: `✅ ${sent} envoyé(s), ${failed} échoué(s)` });
            console.log('');
        }
    } catch (e) {
        results.push({ test: 'Notification Livreurs', status: `❌ ÉCHEC: ${e.message}` });
        console.error('  ❌ Échec:', e.message, '\n');
    }

    // ── TEST 7: notifyLivreurs (via le service, qui filtre les disponibles) ──
    console.log('📨 TEST 7: notifyLivreurs() via notifications.js (livreurs disponibles)...');
    try {
        await notifyLivreurs(bot,
            `🧪 <b>TEST 7 — notifyLivreurs()</b>\n\n` +
            `🆕 <b>COMMANDE TEST (via notifyLivreurs)</b>\n` +
            `📦 Produit Test x1\n` +
            `📍 456 Avenue Test, 13001 Marseille\n` +
            `💰 <b>30.00€</b>\n\n` +
            `<i>⚠️ Ceci est un TEST. Ignorez ce message.</i>\n` +
            `📅 ${timestamp}`
        );
        results.push({ test: 'notifyLivreurs() → Livreurs dispos', status: '✅ OK (envoyé aux disponibles)' });
        console.log('  ✅ Envoyé aux livreurs disponibles !\n');
    } catch (e) {
        results.push({ test: 'notifyLivreurs() → Livreurs dispos', status: `❌ ÉCHEC: ${e.message}` });
        console.error('  ❌ Échec:', e.message, '\n');
    }

    // ── TEST 8: Simulation notification "nouvelle commande" admin ──
    console.log('📨 TEST 8: Simulation notification "nouvelle commande" → admin...');
    try {
        const adminAlert =
            `🚨 <b>NOUVELLE COMMANDE (TEST)</b>\n\n` +
            `📱 <b>Source :</b> Telegram\n` +
            `👤 Client : TestUser (@test_user)\n` +
            `📦 Produit : Produit Test Premium x2\n` +
            `📍 Adresse : 789 Boulevard Test, 69001 Lyon\n` +
            `🚀 <b>ASAP</b>\n` +
            `💰 Total : 45.00€ (💳 CB)\n` +
            `🔑 ID : <code>#TEST1</code>\n\n` +
            `<i>⚠️ Ceci est un TEST. Pas de vraie commande.</i>\n` +
            `📅 ${timestamp}`;

        await notifyAdmins(bot, adminAlert);
        results.push({ test: 'Simulation nouvelle commande → Admin', status: '✅ OK' });
        console.log('  ✅ Envoyé avec succès !\n');
    } catch (e) {
        results.push({ test: 'Simulation nouvelle commande → Admin', status: `❌ ÉCHEC: ${e.message}` });
        console.error('  ❌ Échec:', e.message, '\n');
    }

    // ═══════════════════════════════════════
    // RÉSUMÉ FINAL
    // ═══════════════════════════════════════
    console.log('═══════════════════════════════════════');
    console.log('  📊 RÉSUMÉ DES TESTS');
    console.log('═══════════════════════════════════════');
    for (const r of results) {
        console.log(`  ${r.status} — ${r.test}`);
    }
    console.log('═══════════════════════════════════════\n');

    const failures = results.filter(r => r.status.startsWith('❌'));
    if (failures.length > 0) {
        console.log(`⚠️ ${failures.length} test(s) en échec.`);
    } else {
        console.log('🎉 Tous les tests sont passés !');
    }
}

runTests()
    .then(() => {
        console.log('\n✅ Script terminé. Vérifiez vos messages Telegram.');
        process.exit(0);
    })
    .catch(e => {
        console.error('❌ Erreur fatale:', e);
        process.exit(1);
    });
