/**
 * Vérifie les utilisateurs WhatsApp en DB et l'état du canal WhatsApp
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
    // 1. Tous les users WhatsApp
    const { data: waUsers } = await supabase.from('users')
        .select('id, first_name, is_livreur, is_available, platform')
        .or('id.ilike.whatsapp_%,id.ilike.%@%');

    console.log(`\n📱 UTILISATEURS WHATSAPP EN DB: ${(waUsers||[]).length}`);
    for (const u of (waUsers || [])) {
        const role = u.is_livreur ? '🚚 Livreur' : '👤 Client';
        const dispo = u.is_livreur ? (u.is_available ? '🟢' : '🔴') : '';
        console.log(`  ${role} ${dispo} ${u.first_name || '?'} — ${u.id} (platform: ${u.platform})`);
    }

    // 2. Tous les livreurs (tous canaux)
    const { data: allLivreurs } = await supabase.from('users')
        .select('id, first_name, is_available, platform')
        .eq('is_livreur', true);

    console.log(`\n🚚 TOUS LES LIVREURS: ${(allLivreurs||[]).length}`);
    for (const l of (allLivreurs || [])) {
        const platform = l.id.includes('@') || l.id.startsWith('whatsapp') ? 'WhatsApp' : 'Telegram';
        console.log(`  ${l.is_available ? '🟢' : '🔴'} ${l.first_name || '?'} — ${l.id} (${platform})`);
    }

    // 3. Vérifier les sessions WhatsApp stockées
    const { data: waSessions } = await supabase.from('whatsapp_sessions')
        .select('session_id, created_at')
        .limit(5);

    console.log(`\n🔑 SESSIONS WHATSAPP: ${(waSessions||[]).length}`);
    for (const s of (waSessions || [])) {
        console.log(`  ${s.session_id} — ${s.created_at}`);
    }
}

check().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
