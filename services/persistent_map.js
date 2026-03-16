// PersistentMap - Map wrapper that persists state to Supabase bot_state table
const TABLE = 'bot_state';
const db = () => require('../config/supabase').supabase.from(TABLE);

function createPersistentMap(namespace) {
    const mem = new Map();
    let live = false;
    const rid = (k) => `${namespace}:${k}`;
    const bg = async (fn) => {
        if (!live) return;
        try {
            const res = fn();
            if (res && typeof res.catch === 'function') {
                await res.catch(e => console.error(`[State] ${namespace} async error:`, e.message));
            }
        } catch (e) {
            console.error(`[State] ${namespace} sync error:`, e.message);
        }
    };

    return {
        has: (key) => mem.has(String(key)),
        get: (key) => mem.get(String(key)),
        set(key, val) {
            const k = String(key);
            mem.set(k, val);
            bg(() => db().upsert({ id: rid(k), namespace, user_key: k, value: JSON.parse(JSON.stringify(val)), updated_at: new Date().toISOString() }));
            return this;
        },
        delete(key) {
            const k = String(key), had = mem.has(k);
            mem.delete(k);
            bg(() => db().delete().eq('id', rid(k)));
            return had;
        },
        clear() { mem.clear(); bg(() => db().delete().eq('namespace', namespace)); },
        keys: () => mem.keys(), values: () => mem.values(), entries: () => mem.entries(),
        get size() { return mem.size; },
        forEach: (cb) => mem.forEach(cb),
        [Symbol.iterator]: () => mem[Symbol.iterator](),
        async load() {
            try {
                const { data, error } = await db().select('user_key, value').eq('namespace', namespace);
                if (error) { 
                    console.warn(`[State] ${namespace} load error: ${error.message}`); 
                    // Si la table n'existe pas encore, on marque comme live quand même pour permettre la création
                    live = true;
                    return; 
                }
                for (const r of (data || [])) mem.set(r.user_key, r.value);
                live = true;
                if (mem.size > 0) console.log(`[State] ${namespace}: ${mem.size} entrées restaurées`);
            } catch (e) { 
                console.error(`[State] ${namespace} Exception:`, e.message);
                live = true; // Permettre les opérations même en cas d'erreur de chargement initiale
            }
        }
    };
}

module.exports = { createPersistentMap };
