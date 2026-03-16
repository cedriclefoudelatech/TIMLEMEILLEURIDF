const { supabase } = require('./config/supabase');

async function fixDatabase() {
    console.log('--- FIXING DATABASE ---');
    
    // On essaie de créer la table via SQL brut si possible, 
    // mais PostgREST ne permet pas de créer des tables directement via l'API client.
    // Cependant, je peux vérifier quelles tables existent.
    
    const { data: tables, error } = await supabase.from('bot_users').select('id').limit(1);
    if (error) {
        console.error('Cant even read bot_users:', error.message);
        return;
    }
    console.log('Connected to Supabase successfully.');
    
    console.log('NOTICE: The table "bot_state" is missing.');
    console.log('Please go to Supabase -> SQL Editor and run this:');
    console.log(`
CREATE TABLE IF NOT EXISTS public.bot_state (
    key TEXT PRIMARY KEY,
    value JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);
ALTER TABLE public.bot_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON public.bot_state USING (true) WITH CHECK (true);
    `);
}

fixDatabase();
