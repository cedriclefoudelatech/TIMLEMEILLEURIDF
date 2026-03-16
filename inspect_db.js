const { supabase } = require('./config/supabase');

async function inspectTable() {
    const { data, error } = await supabase.rpc('inspect_bot_state'); // This might not exist
    // Alternative: try to insert a dummy row with the columns expected by the code
    const dummy = {
        id: 'test:test',
        namespace: 'test',
        user_key: 'test',
        value: { foo: 'bar' },
        updated_at: new Date().toISOString()
    };
    
    console.log('Testing insert with columns: id, namespace, user_key, value, updated_at...');
    const { error: insertError } = await supabase.from('bot_state').insert([dummy]);
    
    if (insertError) {
        console.error('Insert failed:', insertError.message);
        if (insertError.message.includes('column "id" of relation "bot_state" does not exist')) {
            console.log('Confirmed: Table structure is incorrect.');
        }
    } else {
        console.log('Insert successful! Table structure is correct.');
        await supabase.from('bot_state').delete().eq('id', 'test:test');
    }
}

inspectTable();
