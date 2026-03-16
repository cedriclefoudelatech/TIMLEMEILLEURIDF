-- =========================================================================
-- MIGRATION : Ajout des colonnes manquantes dans bot_orders
-- Résout l'erreur "Erreur lors de la création de la commande"
-- =========================================================================

ALTER TABLE bot_orders 
  ADD COLUMN IF NOT EXISTS notif_1h_sent BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS notif_30m_sent BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS chat_count NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS help_requests JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS client_reply TEXT;

-- Vérification
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'bot_orders'
ORDER BY ordinal_position;
