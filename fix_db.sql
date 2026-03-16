-- COPIER-COLLER CE CONTENU DANS L'ÉDITEUR SQL SUPABASE --
-- SI LA TABLE EXISTE DÉJÀ AVEC UN MAUVAIS FORMAT, ON LA SUPPRIME ET LA RECRÉE --

DROP TABLE IF EXISTS public.bot_state;

CREATE TABLE public.bot_state (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    user_key TEXT NOT NULL,
    value JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Désactiver RLS pour que le bot puisse lire/écrire sans politique complexe --
ALTER TABLE public.bot_state DISABLE ROW LEVEL SECURITY;

-- Index pour accélérer les recherches par namespace et user_key --
CREATE INDEX IF NOT EXISTS idx_bot_state_lookup ON public.bot_state(namespace, user_key);

COMMENT ON TABLE public.bot_state IS 'Table de stockage du statut persistant du bot (boutons, états menus)';
