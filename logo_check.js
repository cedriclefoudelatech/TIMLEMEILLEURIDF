const { supabase } = require('./services/database');
async function check() {
  const { data, error } = await supabase.from('bot_settings').select('*');
  if (error) {
    console.error('Error:', error);
    return;
  }
  const s = data[0] || {};
  console.log('Bot Logo:', s.ui_logo_url);
  console.log('Splash:', s.ui_splash_url);
}
check();
