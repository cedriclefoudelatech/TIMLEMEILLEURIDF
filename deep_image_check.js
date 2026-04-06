const { supabase } = require('./services/database');
async function check() {
  const { data, error } = await supabase.from('bot_products').select('id, name, image_url');
  if (error) {
    console.error('Error:', error);
    return;
  }
  const withImg = data.filter(p => p.image_url && p.image_url.length > 0);
  console.log('Total products:', data.length);
  console.log('Products with image:', withImg.length);
  if (withImg.length > 0) {
    console.log('Samples with image:', withImg.slice(0, 3));
  }
}
check();
