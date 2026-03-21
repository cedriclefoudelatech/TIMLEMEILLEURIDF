const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function checkOrdersTable() {
    console.log('--- Checking bot_orders table in TIM ---');
    const { data: order, error } = await supabase.from('bot_orders').select('*').limit(1).single();
    if (error) {
        if (error.code === 'PGRST116') {
             console.log('Table exists but is empty.');
             const { error: error2 } = await supabase.from('bot_orders').select('payment_method').limit(1);
             if (error2) console.log('Column payment_method MISSING:', error2.message);
             else console.log('Column payment_method EXISTS.');
        } else {
             console.error('Error:', error);
        }
        return;
    }
    console.log('Columns in bot_orders:', Object.keys(order));
}

checkOrdersTable();
