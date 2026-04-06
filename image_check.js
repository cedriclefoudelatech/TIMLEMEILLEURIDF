const { supabase } = require('./services/database');
async function check() {
  const { data, error } = await supabase.from('bot_products').select('id, name, image_url').limit(5);
  if (error) {
    console.error('Error:', error);
    return;
  }
  console.log('Images:', data.map(p => ({ name: p.name, img: p.image_url })));
}
check();
