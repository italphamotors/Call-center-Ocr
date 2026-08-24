const express = require('express');
const path    = require('path');
const config  = require('./config');

const ocrRoutes    = require('./routes/ocr');
const odooRoutes   = require('./routes/odoo');   // destination active pour l'enregistrement
const sheetsRoutes = require('./routes/sheets'); // en pause (voir README)

const app = express();

// Le JSON peut contenir le fichier scanné encodé en base64 (jusqu'à ~13 Mo
// pour un fichier source de 10 Mo, cf. config.MAX_UPLOAD_SIZE) : on augmente
// la limite par défaut d'Express (100kb) en conséquence.
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/ocr',    ocrRoutes);
app.use('/api/odoo',   odooRoutes);
app.use('/api/sheets', sheetsRoutes);

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`✅ Alpha Motors OCR démarré sur le port ${config.PORT}`);
  console.log(`   Accès local  : http://localhost:${config.PORT}`);
  console.log(`   Accès réseau : http://<IP_DU_SERVEUR>:${config.PORT}`);
});
