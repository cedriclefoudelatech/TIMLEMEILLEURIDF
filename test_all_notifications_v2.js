/**
 * TEST EXHAUSTIF — TOUTES LES NOTIFICATIONS — TELEGRAM + WHATSAPP
 * Initialise les VRAIS canaux (Telegram + WhatsApp Baileys) puis envoie
 * TOUS les types de notifications à TOUS les destinataires.
 */

require('dotenv').config();
const { registry } = require('./channels/ChannelRegistry');
const { initChannels } = require('./services/channel_init');
const { getAppSettings, getAllLivreurs, getAllActiveUsers } = require('./services/database');
const { notifyAdmins, notifyLivreurs, sendMessageToUser } = require('./services/notifications');

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const TS = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
const BANNER_TG = '⚠️ <i>CECI EST UN TEST — Pas de vraie commande</i>';
const BANNER_WA = '⚠️ CECI EST UN TEST — Pas de vraie commande';

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

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function runAllTests() {
    console.log('══════════════════════════════════════════════');
    console.log('  🧪 TEST EXHAUSTIF V2 — TELEGRAM + WHATSAPP');
    console.log(`  📅 ${TS}`);
    console.log('══════════════════════════════════════════════');

    // ── Initialiser les VRAIS canaux ──
    console.log('\n🔌 Initialisation des canaux réels...');
    try {
        await initChannels();
    } catch (e) {
        console.error('❌ Erreur init canaux:', e.message);
    }

    // Fallback server.js setBotInstance
    try {
        const tgChannel = registry.query('telegram');
        if (tgChannel) {
            const server = require('./server');
            if (server.setBotInstance) server.setBotInstance(tgChannel.getBotInstance());
        }
    } catch (e) { }

    // Attendre que WhatsApp se connecte
    const waChannel = registry.query('whatsapp');
    if (waChannel) {
        console.log('⏳ Attente connexion WhatsApp (max 30s)...');
        for (let i = 0; i < 30; i++) {
            if (waChannel.isActive) break;
            await wait(1000);
            process.stdout.write('.');
        }
        console.log('');
    }

    const waActive = waChannel && waChannel.isActive;
    const settings = await getAppSettings();
    const livreurs = await getAllLivreurs();
    const allUsers = await getAllActiveUsers();
    const waUsers = allUsers.filter(u =>
        u.id?.includes('@') || u.id?.startsWith('whatsapp') || u.platform === 'whatsapp'
    );

    console.log(`\n📋 État:`);
    console.log(`   Admin     : ${ADMIN_ID}`);
    console.log(`   Telegram  : 🟢 Actif`);
    console.log(`   WhatsApp  : ${waActive ? '🟢 Actif' : '🔴 Inactif'}`);
    console.log(`   Livreurs  : ${livreurs.length}`);
    for (const l of livreurs) {
        console.log(`     ${l.is_available ? '🟢' : '🔴'} ${l.first_name} (${l.id})`);
    }
    console.log(`   Users WA  : ${waUsers.length}`);
    for (const u of waUsers) {
        console.log(`     📱 ${u.first_name} (${u.id})`);
    }

    // ═══════════════════════════════════════════════
    // A. NOTIFICATIONS ADMIN (16 types via Telegram)
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  📣 A — NOTIFICATIONS ADMIN (Telegram)');
    console.log('══════════════════════════════════════════');

    const adminNotifs = [
        { label: 'Nouvel utilisateur', msg: `👤 <b>NOUVEL UTILISATEUR !</b>\n\n📱 Source : Telegram\n👤 Nom : TestUser\n🆔 @test_user\n🔑 ID : <code>999999999</code>` },
        { label: 'Nouvelle commande', msg: `🚨 <b>NOUVELLE COMMANDE !</b>\n\n📱 <b>Source :</b> Telegram\n👤 Client : Jean Dupont (@jean)\n📦 Produit : Amnesia Haze (x2), OG Kush (x1)\n📍 Adresse : 42 Rue de la Paix, 75002 Paris\n🚀 <b>ASAP</b>\n💰 Total : 85.00€ (💵 Espèces)\n🔑 ID : <code>#AB12C</code>` },
        { label: 'Commande acceptée', msg: `🚗 <b>COMMANDE ACCEPTÉE</b>\n\n🆔 Commande : <code>#AB12C</code>\n👤 Livreur : Gazolina94\n📦 Produit : Amnesia Haze (x2)\n📍 Adresse : 42 Rue de la Paix\n💰 Total : 85.00€` },
        { label: 'ETA envoyé', msg: `⏳ <b>ETA ENVOYÉ</b>\n\n🆔 Commande : <code>#AB12C</code>\n👤 Livreur : Gazolina94\n🕒 ETA : 🕐 ~15 minutes` },
        { label: 'Livreur abandon', msg: `⚠️ <b>LIVREUR ABANDON</b>\n\n🆔 Commande : <code>#AB12C</code>\n👤 Par : Gazolina94\nL'ordre est de nouveau disponible.` },
        { label: 'Commande livrée', msg: `✅ <b>COMMANDE LIVRÉE</b>\n\n🆔 Commande : <code>#AB12C</code>\n👤 Livreur : Gazolina94\n📦 Produit : Amnesia Haze (x2)\n💰 Montant : 85.00€` },
        { label: 'Annulation client', msg: `⚠️ <b>ANNULATION CLIENT</b>\n\nLa commande <b>#AB12C</b> a été annulée par le client.\n👤 Client : Jean Dupont` },
        { label: 'Signalement retard', msg: `⚠️ <b>SIGNALEMENT RETARD</b>\n\n🆔 Commande : <code>#AB12C</code>\n👤 Livreur : Gazolina94\n📝 Motif : "Bouchons, 10 min de retard"` },
        { label: 'Chat relayé', msg: `💬 <b>CHAT CLIENT</b>\n\n🆔 Commande : <code>#AB12C</code>\n👤 De : Jean Dupont\n📝 Message : "Je suis au 3ème, code 1234"` },
        { label: 'Nouvel avis', msg: `🌟 <b>NOUVEL AVIS GÉNÉRAL !</b>\n\n👤 Client : Jean Dupont\n🌟 Note : ⭐⭐⭐⭐⭐\n💬 Commentaire : "Super rapide, produit top !"` },
        { label: 'Contact admin', msg: `💬 <b>CONTACT ADMIN SOLICITÉ</b>\n\n👤 Client : Jean Dupont (@jean)\nID : <code>999999999</code>` },
        { label: 'Fournisseur prêt', msg: `🏪 <b>Fournisseur : produit prêt !</b>\n\nCommande #AB12C marquée comme prête.` },
        { label: 'Statut livreur', msg: `🔔 <b>STATUT LIVREUR</b>\n\n👤 Gazolina94\n📍 Secteur : PARIS\n🔘 ✅ DISPONIBLE` },
        { label: 'Où est ma commande', msg: `❓ <b>DEMANDE "OÙ EST MA COMMANDE"</b>\n\n🆔 ID : <code>#AB12C</code>\n👤 Client : Jean Dupont` },
        { label: 'Paramètre MAJ', msg: `⚙️ <b>PARAMÈTRE MIS À JOUR</b>\n\nClé : welcome_message\nPar : Admin Principal` },
        { label: 'Mode maintenance', msg: `⚙️ <b>MODIFICATION PARAMÈTRE</b>\n\nNom : Maintenance\nNouveau statut : 🔴 ACTIVÉE\nPar : Admin Principal` },
    ];

    for (const n of adminNotifs) {
        await sendTest(n.label, 'Admin TG', async (tag) => {
            await notifyAdmins(null, `${n.msg}\n\n${BANNER_TG}\n🏷️ ${tag} — ${TS}`);
        });
        await wait(250);
    }

    // ═══════════════════════════════════════════════
    // B. NOTIFICATIONS LIVREURS — TELEGRAM (5 types × chaque livreur)
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  🚚 B — NOTIFICATIONS LIVREURS (Telegram)');
    console.log('══════════════════════════════════════════');

    const livreurNotifs = [
        { label: 'Nouvelle commande dispo', msg: `🆕 <b>NOUVELLE COMMANDE !</b>\n\n📦 Amnesia Haze (x2), OG Kush (x1)\n📍 42 Rue de la Paix, 75002 Paris\n🕒 Dès que possible\n💰 <b>85.00€ (💵 Espèces)</b>\n\n<i>Ouvrez votre espace livreur pour la prendre.</i>` },
        { label: 'Commande assignée admin', msg: `🔔 <b>ADMIN: Une commande vous a été assignée !</b>\n\nRegardez vos commandes dans votre espace livreur.` },
        { label: 'Commande annulée client', msg: `⚠️ <b>COMMANDE ANNULÉE</b>\n\nLe client a annulé la commande <b>#AB12C</b>.\nNe vous déplacez pas.` },
        { label: 'Avis client reçu', msg: `👏 <b>Félicitations !</b>\n\nUn client a laissé une note pour votre livraison :\n\n⭐⭐⭐⭐⭐\n💬 "Livraison ultra rapide, merci !"` },
        { label: 'Client demande où vous êtes', msg: `❓ <b>DEMANDE CLIENT (ID #AB12C)</b>\n\nLe client demande où vous en êtes pour sa livraison.\nMerci d'envoyer une estimation ASAP via le menu livreur !` },
    ];

    for (const l of livreurs) {
        console.log(`\n  ── ${l.first_name} (${l.id}) ──`);
        for (const n of livreurNotifs) {
            await sendTest(n.label, `Livreur TG ${l.first_name}`, async (tag) => {
                await sendMessageToUser(l.id, `${n.msg}\n\n${BANNER_TG}\n🏷️ ${tag} — ${TS}`);
            });
            await wait(250);
        }
    }

    // ═══════════════════════════════════════════════
    // C. NOTIFICATIONS CLIENT — TELEGRAM (6 types → admin comme client test)
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  👤 C — NOTIFICATIONS CLIENT (Telegram)');
    console.log('══════════════════════════════════════════');

    const clientId = `telegram_${ADMIN_ID}`;
    const clientNotifs = [
        { label: 'Commande prise en charge', msg: `🚚 <b>Bonne nouvelle !</b>\n\nVotre commande <b>#AB12C</b> est prise en charge par <b>Tim Le Meilleur</b>.\n⏳ Une estimation dans quelques minutes.` },
        { label: 'ETA du livreur', msg: `🔔 <b>Mise à jour Livraison #AB12C</b>\n\nVotre livreur arrive : <b>🕐 ~15 minutes</b>\n\n<i>Restez joignable !</i>` },
        { label: 'Retard signalé', msg: `⚠️ <b>Un retard est à prévoir</b>\n\nVotre livreur signale un imprévu :\n"<i>Bouchons sur le périph, 10 min</i>"\n\nIl fait le maximum !` },
        { label: 'Message du livreur', msg: `💬 <b>Message du livreur</b> (Commande #AB12C)\n\n"Je suis en bas, code d'entrée svp ?"\n\n📊 Message 1/6` },
        { label: 'Commande livrée', msg: `✅ <b>Votre commande #AB12C a été livrée !</b>\n\nMerci de votre confiance et à bientôt chez <b>Tim Le Meilleur</b> ! 🙏` },
        { label: 'Panier abandonné', msg: `🛒 <b>Votre panier vous attend !</b>\n\nIl reste <b>3</b> article(s) dans votre panier chez <b>Tim Le Meilleur</b>.\n\nNe manquez pas nos pépites ! 🔥` },
    ];

    for (const n of clientNotifs) {
        await sendTest(n.label, 'Client TG (admin)', async (tag) => {
            await sendMessageToUser(clientId, `${n.msg}\n\n${BANNER_TG}\n🏷️ ${tag} — ${TS}`);
        });
        await wait(250);
    }

    // ═══════════════════════════════════════════════
    // D. FOURNISSEUR — TELEGRAM
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  🏪 D — NOTIFICATION FOURNISSEUR (Telegram)');
    console.log('══════════════════════════════════════════');

    await sendTest('Nouvelle commande fournisseur', 'Fournisseur TG (admin)', async (tag) => {
        await sendMessageToUser(clientId,
            `📦 <b>Nouvelle commande !</b>\n\n📦 Produit : Amnesia Haze x2\n📍 42 Rue de la Paix, 75002 Paris\n🔑 Commande : #AB12C\n\n${BANNER_TG}\n🏷️ ${tag} — ${TS}`
        );
    });
    await wait(300);

    // ═══════════════════════════════════════════════
    // E. WHATSAPP — Envoi à TOUS les users WhatsApp
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  📱 E — NOTIFICATIONS WHATSAPP');
    console.log('══════════════════════════════════════════');

    if (!waActive) {
        console.log('   🔴 WhatsApp NON CONNECTÉ');
        console.log('   Attente supplémentaire de 15s...');
        await wait(15000);
        // Re-check
        const waChannel2 = registry.query('whatsapp');
        if (waChannel2 && waChannel2.isActive) {
            console.log('   🟢 WhatsApp maintenant connecté !');
        } else {
            console.log('   🔴 Toujours pas connecté. Tests WA ignorés.');
            results.push({ n: '—', label: 'WhatsApp (canal inactif)', recipients: 'N/A', status: '⚠️ Non connecté' });
        }
    }

    // Re-évaluer
    const waChannel2 = registry.query('whatsapp');
    const waReady = waChannel2 && waChannel2.isActive;

    if (waReady) {
        console.log('   🟢 WhatsApp connecté ! Envoi des notifications...\n');

        const waNotifs = [
            { label: 'WA: Nouvelle commande', msg: `🆕 NOUVELLE COMMANDE !\n\n📦 Amnesia Haze (x2), OG Kush (x1)\n📍 42 Rue de la Paix, 75002 Paris\n🕒 Dès que possible\n💰 85.00€ (💵 Espèces)\n\nOuvrez votre espace livreur pour la prendre.` },
            { label: 'WA: Commande acceptée', msg: `🚚 Bonne nouvelle !\n\nVotre commande #AB12C est prise en charge.\n⏳ Une estimation dans quelques minutes.` },
            { label: 'WA: ETA livreur', msg: `🔔 Mise à jour Livraison #AB12C\n\nVotre livreur arrive dans ~15 minutes.\n\nRestez joignable !` },
            { label: 'WA: Retard signalé', msg: `⚠️ Un retard est à prévoir\n\nVotre livreur signale un imprévu :\n"Bouchons, 10 min de retard"\n\nIl fait le maximum !` },
            { label: 'WA: Message du livreur', msg: `💬 Message du livreur (Commande #AB12C)\n\n"Je suis en bas, code d'entrée svp ?"\n\nMessage 1/6` },
            { label: 'WA: Commande livrée', msg: `✅ Votre commande #AB12C a été livrée !\n\nMerci de votre confiance ! 🙏` },
            { label: 'WA: Annulation', msg: `⚠️ COMMANDE ANNULÉE\n\nLa commande #AB12C a été annulée par le client.` },
            { label: 'WA: Panier abandonné', msg: `🛒 Votre panier vous attend !\n\nIl reste 3 article(s) dans votre panier.\nNe manquez pas nos pépites ! 🔥` },
        ];

        // Envoyer à chaque user WhatsApp
        for (const waUser of waUsers) {
            console.log(`\n  ── WA: ${waUser.first_name} (${waUser.id}) ──`);
            for (const n of waNotifs) {
                await sendTest(n.label, `WA ${waUser.first_name}`, async (tag) => {
                    await sendMessageToUser(waUser.id, `${n.msg}\n\n${BANNER_WA}\n🏷️ ${tag} — ${TS}`);
                });
                await wait(500); // Plus lent pour WhatsApp (éviter flood)
            }
        }
    }

    // ═══════════════════════════════════════════════
    // F. notifyLivreurs() via le service (Telegram dispos seulement)
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════');
    console.log('  📡 F — notifyLivreurs() SERVICE');
    console.log('══════════════════════════════════════════');

    await sendTest('notifyLivreurs() service', 'Livreurs dispos', async (tag) => {
        await notifyLivreurs(null,
            `🆕 <b>NOUVELLE COMMANDE (via service) !</b>\n\n📦 Produit Premium (x3)\n📍 99 Boulevard Test, Paris\n💰 <b>120.00€</b>\n\n${BANNER_TG}\n🏷️ ${tag} — ${TS}`
        );
    });

    // ═══════════════════════════════════════════════
    // RÉSUMÉ FINAL
    // ═══════════════════════════════════════════════
    console.log('\n\n══════════════════════════════════════════════');
    console.log('  📊 RÉSUMÉ FINAL');
    console.log('══════════════════════════════════════════════');

    const ok = results.filter(r => r.status === '✅').length;
    const fail = results.filter(r => r.status === '❌').length;
    const warn = results.filter(r => r.status.startsWith('⚠️')).length;

    console.log(`\n  Total : ${results.length} | ✅ ${ok} | ❌ ${fail} | ⚠️ ${warn}\n`);

    for (const r of results) {
        const pad = String(r.n).padStart(2, ' ');
        console.log(`  ${r.status} ${pad}. ${r.label} → ${r.recipients}${r.error ? ` (${r.error})` : ''}`);
    }

    console.log('\n══════════════════════════════════════════════');
    if (fail > 0) console.log(`\n⚠️ ${fail} notification(s) en échec !`);
    else console.log(`\n🎉 TOUT EST PASSÉ !`);
}

runAllTests()
    .then(async () => {
        console.log('\n✅ Script terminé. Vérifie Telegram + WhatsApp !');
        // Fermer proprement le canal WhatsApp
        try {
            const wa = registry.query('whatsapp');
            if (wa && wa.sock) wa.sock.end();
        } catch (e) { }
        setTimeout(() => process.exit(0), 2000);
    })
    .catch(e => {
        console.error('❌ Erreur fatale:', e);
        process.exit(1);
    });
