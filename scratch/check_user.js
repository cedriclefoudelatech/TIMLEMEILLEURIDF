
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkUser() {
    const { data, error } = await supabase
        .from('bot_users')
        .select('*')
        .or('id.eq.whatsapp_33785790191,id.eq.33785790191');

    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log('Users found:', JSON.stringify(data, null, 2));
}

checkUser();
