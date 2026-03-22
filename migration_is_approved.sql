-- Migration: Ajouter la colonne is_approved à bot_users
-- Exécuter dans le SQL Editor de Supabase

ALTER TABLE public.bot_users
ADD COLUMN IF NOT EXISTS is_approved boolean DEFAULT true;

-- Les utilisateurs existants sont approuvés par défaut (true)
-- Les nouveaux utilisateurs seront créés avec is_approved = false (défini dans le code)
