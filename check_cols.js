
const { supabase } = require('./config/supabase');

async function checkColumns() {
    console.log("🔍 Checking columns in bot_orders...");
    try {
        const { data, error } = await supabase
            .from('bot_orders')
            .select('*')
            .limit(1);

        if (error) {
            console.error("❌ Error fetching from bot_orders:", error.message);
            return;
        }

        if (data && data.length > 0) {
            console.log("✅ Columns found in bot_orders:", Object.keys(data[0]).join(', '));
            const missing = ['notif_1h_sent', 'notif_30m_sent', 'chat_count', 'help_requests', 'client_reply'].filter(c => !Object.keys(data[0]).includes(c));
            if (missing.length > 0) {
                console.log("❌ Missing columns:", missing.join(', '));
            } else {
                console.log("✨ All necessary columns are present!");
            }
        } else {
            console.log("⚠️ No data in bot_orders, checking by trying to select specific columns...");
            const cols = ['notif_1h_sent', 'notif_30m_sent', 'chat_count', 'help_requests', 'client_reply'];
            for (const col of cols) {
                const { error: e } = await supabase.from('bot_orders').select(col).limit(1);
                if (e) console.log(`❌ Column ${col} is MISSING`);
                else console.log(`✅ Column ${col} EXISTS`);
            }
        }
    } catch (err) {
        console.error("❌ Uncaught error:", err.message);
    }
}

checkColumns();
