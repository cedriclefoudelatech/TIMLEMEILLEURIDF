const { supabase } = require('./services/database');
async function check() {
  const { data, error } = await supabase.from('bot_products').select('*').limit(5);
  if (error) {
    console.error('Error:', error);
    return;
  }
  console.log('Sample data keys:', data.length > 0 ? Object.keys(data[0]) : 'None');
  console.log('Total counts:', data.length);
}
check();
