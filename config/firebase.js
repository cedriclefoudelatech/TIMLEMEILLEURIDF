const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');
require('dotenv').config();

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const fullPath = saPath.startsWith('.')
        ? path.resolve(process.cwd(), saPath)
        : saPath;

    try {
        serviceAccount = require(fullPath);
        console.log(`✅ Chef de projet identifié : ${serviceAccount.project_id}`);
    } catch (e) {
        console.error(`❌ Impossible de charger le fichier Firebase à : ${fullPath}`);
        process.exit(1);
    }
} else if (process.env.FIREBASE_PROJECT_ID) {
    serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
    console.log(`✅ Initialisation via variables d'env (Project: ${serviceAccount.projectId})`);
} else {
    console.error('❌ Firebase credentials manquantes. Configurez FIREBASE_SERVICE_ACCOUNT_PATH ou FIREBASE_PROJECT_ID.');
    process.exit(1);
}

// Initialisation de l'App
const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// CRITIQUE : Votre base de données s'appelle "default" (sans parenthèses)
// On doit l'appeler explicitement car admin.firestore() cherche "(default)" par défaut.
const db = getFirestore(app, 'default');

console.log('📡 Instance Firestore connectée à la base "default"');

module.exports = { db, admin };
