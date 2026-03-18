const { supabase } = require('./services/database');
(async () => {
    const { data, error } = await supabase.from('bot_settings').select('*').limit(1).single();
    if (error) console.error(error);
    else console.log(JSON.stringify(data, null, 2));
})();
