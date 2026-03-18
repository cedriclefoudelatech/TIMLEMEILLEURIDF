-- Migration: Ajout des colonnes pour tous les textes/boutons éditables
-- Exécuter dans Supabase SQL Editor pour CHAQUE projet (TIM + La Frappe)

-- === BOUTONS DE NAVIGATION ===
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_back_generic TEXT DEFAULT '◀️ Retour';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_back_quick_menu TEXT DEFAULT '◀️ Menu';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_back_to_cart TEXT DEFAULT '◀️ Retour Panier';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_back_to_qty TEXT DEFAULT '◀️ Retour Quantité';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_back_to_address TEXT DEFAULT '◀️ Retour Adresse';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_back_to_options TEXT DEFAULT '◀️ Retour aux options';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_back_to_livreur_menu TEXT DEFAULT '◀️ Menu Livreur';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_back_main_menu_alt TEXT DEFAULT '◀️ Menu principal';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_cancel TEXT DEFAULT '◀️ Annuler';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_modify_address TEXT DEFAULT '◀️ Modifier l''adresse';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_modify_delivery TEXT DEFAULT '◀️ Modifier livraison';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_later TEXT DEFAULT '◀️ Plus tard';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_next TEXT DEFAULT 'Suivant ➡️';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_previous TEXT DEFAULT '⬅️ Précédent';

-- === BOUTONS D'ACTION ===
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_clear_cart TEXT DEFAULT '❌ Vider le panier';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_cancel_alt TEXT DEFAULT '❌ Annuler';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_cancel_order TEXT DEFAULT '❌ Annuler la commande';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_cancel_my_order TEXT DEFAULT '❌ Annuler ma commande';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_abandon_delivery TEXT DEFAULT '❌ Abandonner la livraison';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_dont_use_credit TEXT DEFAULT '❌ Non, payer plein tarif';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_send_now TEXT DEFAULT '✅ Envoyer maintenant';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_set_available TEXT DEFAULT '✅ Passer en Disponible';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_leave_review_alt TEXT DEFAULT '⭐️ Laisser un avis / Commentaire';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_leave_review_simple TEXT DEFAULT '⭐️ Laisser un avis';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_help_support TEXT DEFAULT '❓ Aide & Support';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_where_is_delivery TEXT DEFAULT '⏳ Où en est ma livraison ?';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_notify_30min TEXT DEFAULT '⏳ 30 min';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_notify_10min TEXT DEFAULT '⏳ 10 min';

-- === NOTES / ÉTOILES ===
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_rate_5 TEXT DEFAULT '⭐️⭐️⭐️⭐️⭐️ Excellent';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_rate_4 TEXT DEFAULT '⭐️⭐️⭐️⭐️ Très bien';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_rate_3 TEXT DEFAULT '⭐️⭐️⭐️ Bien';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_rate_1 TEXT DEFAULT '⭐️ Moyen / Insatisfait';

-- === MESSAGES D'ERREUR ===
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_session_expired TEXT DEFAULT '❌ Session expirée.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_product_not_found TEXT DEFAULT '❌ Produit non trouvé.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_order_not_available TEXT DEFAULT '❌ Cette commande n''est plus disponible.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_order_not_found TEXT DEFAULT '❌ Commande introuvable.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_order_creation_error TEXT DEFAULT '❌ Erreur lors de la création de la commande...';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_not_livreur TEXT DEFAULT '❌ Vous n''êtes pas livreur.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_access_denied TEXT DEFAULT '❌ Accès refusé.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_error_fetching_orders TEXT DEFAULT '❌ Erreur lors de la récupération de vos commandes.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_error_fetching_history TEXT DEFAULT '❌ Erreur lors de la récupération de l''historique.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_position_usage TEXT DEFAULT '❌ Usage: /ma_position [ville]';

-- === MESSAGES ÉTATS VIDES ===
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_catalog_empty TEXT DEFAULT '📭 Le catalogue est actuellement vide.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_cart_empty TEXT DEFAULT '📭 Votre panier est vide.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_no_reviews_yet TEXT DEFAULT '📭 Aucun avis pour le moment. Soyez le premier !';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_no_information TEXT DEFAULT '📭 Aucune information à afficher pour le moment.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_no_active_deliveries TEXT DEFAULT '📭 Aucune livraison en cours.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_empty_delivery_history TEXT DEFAULT '📭 Votre historique de livraison est vide.';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_no_active_orders TEXT DEFAULT '📭 Vous n''avez aucune commande active.';

-- === MESSAGES DE CONFIRMATION ===
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_cart_cleared TEXT DEFAULT '✅ Panier vidé !';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_thanks_for_feedback TEXT DEFAULT '🙏 Merci pour votre note !';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_location_updated TEXT DEFAULT '📍 Secteur mis à jour';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_livreur_welcome TEXT DEFAULT '🚴 <b>Bienvenue dans l''équipe de livraison !</b>';
