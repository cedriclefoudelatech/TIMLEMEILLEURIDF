-- Table pour stocker les sessions WhatsApp dans Supabase (survit aux redéploiements Railway)
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  data JSONB,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (session_id, key)
);

-- Index pour les requêtes par session
CREATE INDEX IF NOT EXISTS idx_wa_sessions_session_id ON whatsapp_sessions(session_id);
