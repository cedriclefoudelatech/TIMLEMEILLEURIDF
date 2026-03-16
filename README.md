# TIM LE MEILLEUR IDF - Bot Telegram

Bot Telegram de livraison pour **TIM LE MEILLEUR IDF**, basé sur Node.js (Telegraf) + Supabase + interface web admin.

## Installation

```bash
npm install
```

## Configuration

Copier `.env.example` vers `.env` et remplir les valeurs :

```env
BOT_TOKEN=votre_token_telegram
ADMIN_TELEGRAM_ID=votre_id_telegram
SUPABASE_URL=https://votre-projet.supabase.co
SUPABASE_KEY=votre_cle_service_role
ENCRYPTION_KEY=votre_cle_chiffrement
PORT=3000
ADMIN_PASSWORD=votre_mot_de_passe
LICENSE_KEY=votre_cle_licence
```

### Générer la clé de licence

```bash
node generate-license.js https://votre-projet.supabase.co
```

## Base de données Supabase

Exécutez le fichier `supabase_schema.sql` dans l'éditeur SQL de votre projet Supabase pour créer toutes les tables.

## Lancement

```bash
# Développement
npm run dev

# Production
npm start
```

## Bot Telegram

- Username : @TIMLEMEILLEURIDFBOT
- Contact admin : @Lejardinidf
