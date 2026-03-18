-- Mise à jour pour le support du mode de paiement
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'cash';
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';

-- Ajout d'une colonne facultative pour les détails du paiement carte (ex: transaction_id)
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS payment_ref TEXT;
