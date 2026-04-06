const { supabase } = require('./services/database');
async function check() {
  const { data, error } = await supabase.from('supplier_marketplace').select('*').limit(1);
  if (error) {
    console.error('Error fetching marketplace:', error);
  } else {
    console.log('Marketplace exists, count:', data.length);
  }
}
check();
