
const { supabase, COL_USERS, getAppSettings } = require('../services/database');

async function checkUsers() {
    console.log('--- Database Check ---');
    const { data: users, error } = await supabase.from(COL_USERS).select('*');
    if (error) {
        console.error('Error fetching users:', error);
        return;
    }

    const livreurs = users.filter(u => u.is_livreur);
    console.log(`Found ${livreurs.length} livreurs:`);
    livreurs.forEach(l => {
        console.log(`- ID: ${l.id}, Available: ${l.is_available}, Name: ${l.first_name || l.username}`);
    });

    const settings = await getAppSettings();
    console.log('\n--- Admin Settings ---');
    console.log('admin_telegram_id (DB):', settings.admin_telegram_id);
    console.log('ADMIN_TELEGRAM_ID (ENV):', process.env.ADMIN_TELEGRAM_ID);
}

checkUsers();
