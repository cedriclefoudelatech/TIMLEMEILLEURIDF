/**
 * Vérifie les utilisateurs WhatsApp via les fonctions DB (avec déchiffrement)
 */
require('dotenv').config();
const { getAllLivreurs, getAllActiveUsers, getAppSettings } = require('./services/database');

async function check() {
    // 1. Settings
    const settings = await getAppSettings();
    console.log(`\n⚙️ admin_telegram_id: "${settings.admin_telegram_id}"`);

    // 2. Tous les livreurs
    const livreurs = await getAllLivreurs();
    console.log(`\n🚚 LIVREURS (${livreurs.length}):`);
    for (const l of livreurs) {
        const isWA = l.id?.includes('@') || l.id?.startsWith('whatsapp') || l.platform === 'whatsapp';
        const platform = isWA ? '📱 WhatsApp' : '💬 Telegram';
        console.log(`  ${l.is_available ? '🟢' : '🔴'} ${l.first_name || '?'} — ${l.id} ${platform}`);
    }

    // 3. Tous les users actifs (chercher les WhatsApp)
    const allUsers = await getAllActiveUsers();
    const waUsers = allUsers.filter(u =>
        u.id?.includes('@') || u.id?.startsWith('whatsapp') || u.platform === 'whatsapp'
    );
    console.log(`\n📱 UTILISATEURS WHATSAPP (${waUsers.length} sur ${allUsers.length} total):`);
    for (const u of waUsers.slice(0, 20)) {
        const role = u.is_livreur ? '🚚 Livreur' : '👤 Client';
        console.log(`  ${role} ${u.first_name || '?'} — ${u.id} (platform: ${u.platform})`);
    }
    if (waUsers.length > 20) console.log(`  ... et ${waUsers.length - 20} autres`);

    // 4. Chercher si certains livreurs ont un ID WhatsApp alternatif
    console.log(`\n📋 TOUS LES USERS (${allUsers.length} total) - premiers 10:`);
    for (const u of allUsers.slice(0, 10)) {
        console.log(`  ${u.first_name || '?'} — ${u.id} (platform: ${u.platform})`);
    }
}

check().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
