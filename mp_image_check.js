const { supabase } = require('./services/database');
async function check() {
  const { data, error } = await supabase.from('supplier_marketplace').select('id, name, image_url');
  if (error) {
    console.error('Error:', error);
    return;
  }
  console.log('Supplier Products:', data.length);
  if (data.length > 0) {
    console.log('Sample images:', data.slice(0, 3).map(p => ({ name: p.name, img: p.image_url })));
  }
}
check();
