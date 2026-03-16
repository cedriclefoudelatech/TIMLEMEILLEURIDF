
const { supabase } = require('./config/supabase');

async function checkCols() {
    const { data, error } = await supabase.from('bot_settings').select('*').limit(1);
    if (error) {
        console.error(error);
        return;
    }
    console.log(Object.keys(data[0]).sort().join(', '));
}
checkCols();
