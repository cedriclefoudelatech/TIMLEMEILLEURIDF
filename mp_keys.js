const { supabase } = require('./services/database');
async function check() {
  const { data, error } = await supabase.from('supplier_marketplace').select('*').limit(1);
  if (error) {
    console.error('Error:', error);
    return;
  }
  console.log('MP Keys:', data.length > 0 ? Object.keys(data[0]) : 'None');
}
check();
