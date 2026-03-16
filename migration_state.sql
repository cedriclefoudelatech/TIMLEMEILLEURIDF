-- Migration: Table bot_state pour persister l'état en mémoire (paniers, checkout, chats)
-- Exécutez ce SQL dans l'éditeur SQL de Supabase

CREATE TABLE IF NOT EXISTS bot_state (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  user_key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_state_namespace ON bot_state(namespace);
