/**
 * TEST EXHAUSTIF DE TOUTES LES NOTIFICATIONS DU BOT
 * Envoie les 22 types de notifications à TOUS les destinataires
 * (admin, livreurs, clients simulés) sur Telegram + WhatsApp
 *
 * Usage: node test_all_notifications.js
 */

require('dotenv').config();
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

if (!BOT_TOKEN || !ADMIN_ID) {
    console.error('❌ BOT_TOKEN ou ADMIN_TELEGRAM_ID manquant dans .env');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const { registry } = require('./channels/ChannelRegistry');
const { getAppSettings, getAllLivreurs } = require('./services/database');

// Enregistrer Telegram dans le registre
registry.register({
    type: 'telegram',
    name: 'Telegram (Test)',
    isActive: true,
    getBotInstance: () => bot
});

// Fallback server.js
try {
    const server = require('./server');
    if (server.setBotInstance) server.setBotInstance(bot);
} catch (e) { }

const { notifyAdmins, notifyLivreurs, sendMessageToUser } = require('./services/notifications');

const TS = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
const BANNER = '⚠️ <i>CECI EST UN TEST — Pas de vraie commande</i>';
const results = [];
let testNum = 0;

async function sendTest(label, recipients, fn) {
    testNum++;
    const tag = `TEST ${testNum}`;
    console.log(`\n📨 ${tag}: ${label} → ${recipients}`);
    try {
        await fn(tag);
        results.push({ n: testNum, label, recipients, status: '✅' });
        console.log(`   ✅ OK`);
    } catch (e) {
        results.push({ n: testNum, label, recipients, status: '❌', error: e.message });
        console.error(`   ❌ ${e.message}`);
    }
}

// Petit délai pour ne pas flood l'API Telegram
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function runAllTests() {
    console.log('══════════════════════════════════════════════');
    console.log('  🧪 TEST EXHAUSTIF — TOUTES LES NOTIFICATIONS');
    console.log(`  📅 ${TS}`);
    console.log('══════════════════════════════════════════════');

    // Charger la config
    const settings = await getAppSettings();
    const livreurs = await getAllLivreurs();
    const allLivreurIds = livreurs.map(l => l.id);

    console.log(`\n📋 Config:`);
    console.log(`   Admin DB : "${settings.admin_telegram_id}"`);
    console.log(`   Admin ENV: "${ADMIN_ID}"`);
    console.log(`   Livreurs  : ${livreurs.length}`);
    for (const l of livreurs) {
        console.log(`     - ${l.first_name} (${l.id}) ${l.is_available ? '🟢' : '🔴'}`);
    }

    // Vérifier WhatsApp
    const waChannel = registry.query('whatsapp');
    const waActive = waChannel && waChannel.isActive;
    console.log(`   WhatsApp  : ${waActive ? '🟢 Actif' : '🔴 Inactif (pas connecté)'}`);

    // ═══════════════════════════════════════════════
    // SECTION A : NOTIFICATIONS ADMIN (16 types)
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  📣 SECTION A — NOTIFICATIONS ADMIN');
    console.log('══════════════════════════════════════════');

    // 1. Nouveau utilisateur
    await sendTest('Nouvel utilisateur', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `👤 <b>NOUVEL UTILISATEUR !</b>\n\n` +
            `📱 Source : Telegram\n` +
            `👤 Nom : TestUser\n` +
            `🆔 Username : @test_user_fake\n` +
            `🔑 ID : <code>999999999</code>\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 2. Nouvelle commande
    await sendTest('Nouvelle commande', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `🚨 <b>NOUVELLE COMMANDE !</b>\n\n` +
            `📱 <b>Source :</b> Telegram\n` +
            `👤 Client : Jean Dupont (@jean_dupont)\n` +
            `📦 Produit : Amnesia Haze (x2), OG Kush (x1)\n` +
            `📍 Adresse : 42 Rue de la Paix, 75002 Paris\n` +
            `🚀 <b>ASAP</b>\n` +
            `💰 Total : 85.00€ (💵 Espèces)\n` +
            `🔑 ID : <code>#AB12C</code>\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 3. Commande acceptée par livreur
    await sendTest('Commande acceptée par livreur', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `🚗 <b>COMMANDE ACCEPTÉE</b>\n\n` +
            `🆔 Commande : <code>#AB12C</code>\n` +
            `👤 Livreur : Gazolina94\n` +
            `📦 Produit : Amnesia Haze (x2)\n` +
            `📍 Adresse : 42 Rue de la Paix, 75002 Paris\n` +
            `💰 Total : 85.00€\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 4. ETA envoyé
    await sendTest('ETA envoyé au client', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `⏳ <b>ETA ENVOYÉ</b>\n\n` +
            `🆔 Commande : <code>#AB12C</code>\n` +
            `👤 Livreur : Gazolina94\n` +
            `🕒 ETA : 🕐 ~15 minutes\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 5. Livreur abandonne commande
    await sendTest('Livreur abandonne commande', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `⚠️ <b>LIVREUR ABANDON</b>\n\n` +
            `🆔 Commande : <code>#AB12C</code>\n` +
            `👤 Par : Gazolina94\n` +
            `L'ordre est de nouveau disponible.\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 6. Commande livrée
    await sendTest('Commande livrée', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `✅ <b>COMMANDE LIVRÉE</b>\n\n` +
            `🆔 Commande : <code>#AB12C</code>\n` +
            `👤 Livreur : Gazolina94\n` +
            `📦 Produit : Amnesia Haze (x2)\n` +
            `💰 Montant : 85.00€\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 7. Annulation client
    await sendTest('Annulation par le client', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `⚠️ <b>ANNULATION CLIENT</b>\n\n` +
            `La commande <b>#AB12C</b> a été annulée par le client.\n` +
            `👤 Client : Jean Dupont\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 8. Signalement retard
    await sendTest('Signalement retard livreur', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `⚠️ <b>SIGNALEMENT RETARD</b>\n\n` +
            `🆔 Commande : <code>#AB12C</code>\n` +
            `👤 Livreur : Gazolina94\n` +
            `📝 Motif : "Bouchons sur le périph, 10 min de retard"\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 9. Chat message relayé
    await sendTest('Message chat relayé (client→livreur)', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `💬 <b>CHAT CLIENT</b>\n\n` +
            `🆔 Commande : <code>#AB12C</code>\n` +
            `👤 De : Jean Dupont\n` +
            `📝 Message : "Je suis au 3ème étage, code 1234"\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 10. Avis général
    await sendTest('Nouvel avis client', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `🌟 <b>NOUVEL AVIS GÉNÉRAL !</b>\n\n` +
            `👤 Client : Jean Dupont\n` +
            `🌟 Note : ⭐⭐⭐⭐⭐\n` +
            `💬 Commentaire : "Super rapide, produit top !"\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 11. Contact admin solicité
    await sendTest('Contact admin solicité', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `💬 <b>CONTACT ADMIN SOLICITÉ</b>\n\n` +
            `👤 Client : Jean Dupont (@jean_dupont)\n` +
            `ID : <code>999999999</code>\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 12. Fournisseur produit prêt
    await sendTest('Fournisseur: produit prêt', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `🏪 <b>Fournisseur : produit prêt !</b>\n\n` +
            `Commande #AB12C marquée comme prête par le fournisseur.\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 13. Statut livreur changé
    await sendTest('Changement statut livreur', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `🔔 <b>STATUT LIVREUR</b>\n\n` +
            `👤 Gazolina94\n` +
            `📍 Secteur : PARIS\n` +
            `🔘 ✅ DISPONIBLE\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 14. Demande "où est ma commande"
    await sendTest('Client demande où est sa commande', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `❓ <b>DEMANDE "OÙ EST MA COMMANDE"</b>\n\n` +
            `🆔 ID : <code>#AB12C</code>\n` +
            `👤 Client : Jean Dupont\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 15. Paramètre mis à jour
    await sendTest('Paramètre admin mis à jour', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `⚙️ <b>PARAMÈTRE MIS À JOUR</b>\n\n` +
            `Clé : welcome_message\n` +
            `Par : Admin Principal\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // 16. Mode maintenance
    await sendTest('Mode maintenance togglé', 'Admin', async (tag) => {
        await notifyAdmins(bot,
            `⚙️ <b>MODIFICATION PARAMÈTRE</b>\n\n` +
            `Nom : Maintenance\n` +
            `Nouveau statut : 🔴 ACTIVÉE\n` +
            `Par : Admin Principal\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(500);

    // ═══════════════════════════════════════════════
    // SECTION B : NOTIFICATIONS LIVREURS (5 types)
    // Envoyées à TOUS les livreurs (dispo ou pas)
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  🚚 SECTION B — NOTIFICATIONS LIVREURS');
    console.log('══════════════════════════════════════════');

    for (const livreur of livreurs) {
        const lid = livreur.id;
        const lname = livreur.first_name || 'Inconnu';
        console.log(`\n  ── Livreur: ${lname} (${lid}) ──`);

        // B1. Nouvelle commande disponible
        await sendTest(`Nouvelle commande dispo`, `Livreur ${lname}`, async (tag) => {
            await sendMessageToUser(lid,
                `🆕 <b>NOUVELLE COMMANDE !</b>\n\n` +
                `📦 Amnesia Haze (x2), OG Kush (x1)\n` +
                `📍 42 Rue de la Paix, 75002 Paris\n` +
                `🕒 Dès que possible\n` +
                `💰 <b>85.00€ (💵 Espèces)</b>\n\n` +
                `<i>Ouvrez votre espace livreur pour la prendre.</i>\n\n` +
                `${BANNER}\n🏷️ ${tag} — ${TS}`
            );
        });
        await wait(300);

        // B2. Commande assignée par admin
        await sendTest(`Commande assignée par admin`, `Livreur ${lname}`, async (tag) => {
            await sendMessageToUser(lid,
                `🔔 <b>ADMIN: Une commande vous a été assignée !</b>\n\n` +
                `Regardez vos commandes dans votre espace livreur.\n\n` +
                `${BANNER}\n🏷️ ${tag} — ${TS}`
            );
        });
        await wait(300);

        // B3. Commande annulée par client
        await sendTest(`Commande annulée (client)`, `Livreur ${lname}`, async (tag) => {
            await sendMessageToUser(lid,
                `⚠️ <b>COMMANDE ANNULÉE</b>\n\n` +
                `Le client a annulé la commande <b>#AB12C</b>.\n` +
                `Ne vous déplacez pas.\n\n` +
                `${BANNER}\n🏷️ ${tag} — ${TS}`
            );
        });
        await wait(300);

        // B4. Avis client reçu
        await sendTest(`Avis client reçu`, `Livreur ${lname}`, async (tag) => {
            await sendMessageToUser(lid,
                `👏 <b>Félicitations !</b>\n\n` +
                `Un client a laissé une note pour votre livraison :\n\n` +
                `⭐⭐⭐⭐⭐\n` +
                `💬 "Livraison ultra rapide, merci !"\n\n` +
                `${BANNER}\n🏷️ ${tag} — ${TS}`
            );
        });
        await wait(300);

        // B5. Client demande où est le livreur
        await sendTest(`Client demande où vous êtes`, `Livreur ${lname}`, async (tag) => {
            await sendMessageToUser(lid,
                `❓ <b>DEMANDE CLIENT (ID #AB12C)</b>\n\n` +
                `Le client demande où vous en êtes pour sa livraison.\n` +
                `Merci de lui envoyer une estimation ASAP via le menu livreur !\n\n` +
                `${BANNER}\n🏷️ ${tag} — ${TS}`
            );
        });
        await wait(500);
    }

    // ═══════════════════════════════════════════════
    // SECTION C : NOTIFICATIONS CLIENT (6 types)
    // Envoyées à l'admin (qui joue le rôle du client test)
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  👤 SECTION C — NOTIFICATIONS CLIENT');
    console.log('  (envoyées à l\'admin comme client test)');
    console.log('══════════════════════════════════════════');

    const clientTestId = `telegram_${ADMIN_ID}`;

    // C1. Commande prise en charge
    await sendTest('Commande prise en charge', 'Client (admin)', async (tag) => {
        await sendMessageToUser(clientTestId,
            `🚚 <b>Bonne nouvelle !</b>\n\n` +
            `Votre commande <b>#AB12C</b> est prise en charge par <b>Tim Le Meilleur</b>.\n` +
            `⏳ Une estimation vous sera donnée dans quelques minutes.\n\n` +
            `<i>Besoin de parler au livreur ou à l'admin ? Utilisez les boutons ci-dessous.</i>\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // C2. ETA du livreur
    await sendTest('ETA du livreur', 'Client (admin)', async (tag) => {
        await sendMessageToUser(clientTestId,
            `🔔 <b>Mise à jour Livraison #AB12C</b>\n\n` +
            `Votre livreur vous informe qu'il arrive : <b>🕐 ~15 minutes</b>\n\n` +
            `<i>Restez joignable !</i>\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // C3. Signalement retard
    await sendTest('Retard signalé par livreur', 'Client (admin)', async (tag) => {
        await sendMessageToUser(clientTestId,
            `⚠️ <b>Un retard est à prévoir</b>\n\n` +
            `Votre livreur nous signale un imprévu :\n` +
            `"<i>Bouchons sur le périphérique, 10 min de retard</i>"\n\n` +
            `Il fait le maximum pour arriver vite !\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // C4. Message chat du livreur
    await sendTest('Message du livreur (chat)', 'Client (admin)', async (tag) => {
        await sendMessageToUser(clientTestId,
            `💬 <b>Message du livreur</b> (Commande #AB12C)\n\n` +
            `"Je suis en bas de chez vous, code d'entrée svp ?"\n\n` +
            `📊 Message 1/6\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // C5. Commande livrée
    await sendTest('Commande livrée', 'Client (admin)', async (tag) => {
        await sendMessageToUser(clientTestId,
            `✅ <b>Votre commande #AB12C a été livrée !</b>\n\n` +
            `Merci de votre confiance et à bientôt chez <b>Tim Le Meilleur</b> ! 🙏\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // C6. Panier abandonné
    await sendTest('Rappel panier abandonné', 'Client (admin)', async (tag) => {
        await sendMessageToUser(clientTestId,
            `🛒 <b>Votre panier vous attend !</b>\n\n` +
            `Il reste encore <b>3</b> article(s) dans votre panier chez <b>Tim Le Meilleur</b>.\n\n` +
            `Ne manquez pas nos pépites du moment ! 🔥\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // ═══════════════════════════════════════════════
    // SECTION D : NOTIFICATION FOURNISSEUR (1 type)
    // Envoyée à l'admin comme test fournisseur
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  🏪 SECTION D — NOTIFICATION FOURNISSEUR');
    console.log('══════════════════════════════════════════');

    await sendTest('Nouvelle commande fournisseur', 'Fournisseur (admin)', async (tag) => {
        await sendMessageToUser(clientTestId,
            `📦 <b>Nouvelle commande !</b>\n\n` +
            `📦 Produit : Amnesia Haze x2\n` +
            `📍 Adresse : 42 Rue de la Paix, 75002 Paris\n` +
            `🔑 Commande : #AB12C\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // ═══════════════════════════════════════════════
    // SECTION E : TEST WhatsApp (si actif)
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  📱 SECTION E — TEST WHATSAPP');
    console.log('══════════════════════════════════════════');

    if (waActive) {
        // Trouver des users WhatsApp parmi les livreurs
        const waLivreurs = livreurs.filter(l => l.id.includes('@') || l.id.startsWith('whatsapp'));
        if (waLivreurs.length > 0) {
            for (const wl of waLivreurs) {
                await sendTest('Test WhatsApp notification', `WA Livreur ${wl.first_name}`, async (tag) => {
                    await sendMessageToUser(wl.id,
                        `🧪 TEST WHATSAPP — ${tag}\n\n` +
                        `📦 NOUVELLE COMMANDE TEST\n` +
                        `📍 42 Rue de la Paix, Paris\n` +
                        `💰 85.00€\n\n` +
                        `⚠️ Ceci est un test. ${TS}`
                    );
                });
                await wait(300);
            }
        } else {
            console.log('   ⚠️ WhatsApp actif mais aucun livreur WhatsApp trouvé');
            results.push({ n: '—', label: 'WhatsApp livreurs', recipients: 'N/A', status: '⚠️ Aucun livreur WA' });
        }

        // Test envoi WhatsApp à un numéro test (l'admin)
        await sendTest('Test WhatsApp → admin', 'Admin WA', async (tag) => {
            // Essayer d'envoyer via WhatsApp si un numéro est connu
            const adminUser = await require('./services/database').getUser(`telegram_${ADMIN_ID}`);
            if (adminUser && adminUser.whatsapp_id) {
                await sendMessageToUser(adminUser.whatsapp_id,
                    `🧪 TEST WHATSAPP ADMIN — ${tag}\n` +
                    `Si vous voyez ce message, WhatsApp fonctionne.\n` +
                    `${TS}`
                );
            } else {
                throw new Error('Pas de WhatsApp ID trouvé pour l\'admin');
            }
        });
    } else {
        console.log('   ⚠️ WhatsApp non connecté — tests WA ignorés');
        results.push({ n: '—', label: 'WhatsApp', recipients: 'N/A', status: '⚠️ Non connecté' });
    }

    // ═══════════════════════════════════════════════
    // SECTION F : notifyLivreurs() via le service
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  📡 SECTION F — notifyLivreurs() SERVICE');
    console.log('══════════════════════════════════════════');

    await sendTest('notifyLivreurs() — commande test', 'Livreurs dispos (service)', async (tag) => {
        await notifyLivreurs(bot,
            `🆕 <b>NOUVELLE COMMANDE !</b>\n\n` +
            `📦 Produit Test Premium (x3)\n` +
            `📍 99 Boulevard Test, 75008 Paris\n` +
            `🕒 Dès que possible\n` +
            `💰 <b>120.00€ (💳 CB)</b>\n\n` +
            `<i>Ouvrez votre espace livreur pour la prendre.</i>\n\n` +
            `${BANNER}\n🏷️ ${tag} — ${TS}`
        );
    });

    // ═══════════════════════════════════════════════
    // RÉSUMÉ FINAL
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════════');
    console.log('  📊 RÉSUMÉ FINAL — TOUS LES TESTS');
    console.log('══════════════════════════════════════════════');

    const ok = results.filter(r => r.status === '✅').length;
    const fail = results.filter(r => r.status === '❌').length;
    const warn = results.filter(r => r.status.startsWith('⚠️')).length;

    console.log(`\n  Total : ${results.length} tests`);
    console.log(`  ✅ Réussis : ${ok}`);
    console.log(`  ❌ Échoués : ${fail}`);
    console.log(`  ⚠️ Avertis : ${warn}`);
    console.log('');

    for (const r of results) {
        const pad = String(r.n).padStart(2, ' ');
        console.log(`  ${r.status} ${pad}. ${r.label} → ${r.recipients}${r.error ? ` (${r.error})` : ''}`);
    }

    console.log('\n══════════════════════════════════════════════');

    if (fail > 0) {
        console.log(`\n⚠️ ${fail} notification(s) en échec !`);
    } else {
        console.log(`\n🎉 TOUS LES TESTS SONT PASSÉS !`);
    }
}

runAllTests()
    .then(() => {
        console.log('\n✅ Script terminé. Vérifie tes messages Telegram et WhatsApp !');
        process.exit(0);
    })
    .catch(e => {
        console.error('❌ Erreur fatale:', e);
        process.exit(1);
    });
