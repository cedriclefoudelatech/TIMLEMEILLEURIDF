const { supabase } = require('./services/database');
async function check() {
  const { data, error } = await supabase.from('bot_products').select('id, name, is_active');
  if (error) {
    console.error('Error:', error);
    return;
  }
  console.log('Products:', data);
}
check();
