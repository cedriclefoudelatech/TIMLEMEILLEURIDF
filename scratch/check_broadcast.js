const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

async function check() {
    const { data, error } = await supabase
        .from('bot_broadcasts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5);

    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log('Last Broadcasts:');
    data.forEach(bc => {
        console.log(`ID: ${bc.id} | Status: ${bc.status} | Success: ${bc.success} | Failed: ${bc.failed} | Total: ${bc.total_target} | Created: ${bc.created_at}`);
    });
}

check();
