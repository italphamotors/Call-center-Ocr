# Alpha Motors — OCR vers Odoo

Application web : on choisit le type de fiche (Suivi des RDV / Fiche appel), on scanne ou
photographie le document, Mistral OCR lit le texte puis le structure en JSON, on vérifie/corrige
les lignes à l'écran, et on enregistre dans Odoo.

Construite sur le même modèle que le projet `ocr-presence` que vous m'avez montré (Node.js +
Express + Multer + Mistral + Odoo JSON-RPC), adapté à deux nouveaux types de documents au lieu
des fiches de présence.

## ⚠️ À faire avant tout : sécurité

Le fichier `config.js` du projet `ocr-presence` que vous m'avez transmis contenait, en valeur par
défaut codée en dur, une **clé API Mistral et un mot de passe Odoo réels**. Si ce dépôt a été
poussé sur GitHub (même privé) à un moment donné, ces identifiants doivent être considérés comme
compromis :

1. **Régénérez la clé API Mistral** (console Mistral → API keys).
2. **Changez le mot de passe / la clé API du compte Odoo** `service.it@alphamotors-cameroun.com`.
3. Vérifiez l'historique Git du dépôt (`git log -p -- config.js`) et, si besoin, purgez-le
   (`git filter-repo` ou BFG) avant de rendre le dépôt public.

Ce nouveau projet ne contient **aucun identifiant en dur** : tout passe par `.env` (qui est dans
`.gitignore` et ne doit jamais être commité).

## Démarrage rapide

```bash
cp .env.example .env
# éditez .env avec votre clé Mistral + vos identifiants Odoo

npm install
npm start
# → http://localhost:3000
```

## Avec Docker

```bash
cp .env.example .env
# éditez .env

docker compose up -d --build
# → http://localhost:8091
```

Le `docker-compose.yml` suppose un réseau Docker externe `odoo_odoo_network`, comme dans
`ocr-presence`, pour que le conteneur puisse joindre Odoo. Adaptez ce nom si votre installation
Odoo utilise un autre réseau — ou supprimez la section `networks` si Odoo est accessible par
internet public.

## Enregistrement dans Odoo (destination active)

### Suivi des RDV — inchangé
Chaque ligne devient une fiche dans `x_suivi_rdv_ocr`, avec l'étiquette **"scan"**, un **statut**
initial `nouveau`, et une **activité** Odoo "Appeler" (échéance = date du RDV, assignée à
l'utilisateur Odoo correspondant au nom de l'agent si trouvé, sinon au compte de service).

### Fiche appel — historisé (en-tête + lignes)
Chaque scan validé crée **une fiche d'en-tête** dans `x_fiche_appel_scan` (date du scan, date de
la fiche papier, agent, étiquette "scan", statut) et **une ligne par appel** dans
`x_fiche_appel_ligne`, reliée à l'en-tête via `x_studio_fiche_id`. Le fichier/photo d'origine est
joint à l'en-tête comme pièce jointe Odoo standard. L'anti-doublon se fait au niveau de la fiche
entière (date + agent + jeu de numéros identique = déjà scannée, aucune recréation).

Champs à créer dans Odoo Studio :

| Modèle | Champ | Type | Variable d'env |
|---|---|---|---|
| `x_suivi_rdv_ocr` | Étiquette "scan" | Tags / texte / case à cocher (détecté auto) | `ODOO_TAG_FIELD_RDV` |
| `x_suivi_rdv_ocr` | Statut | Selection (`nouveau`/`a_rappeler`/`contacte`/`traite`) | `ODOO_STATUS_FIELD_RDV` |
| `x_fiche_appel_scan` (en-tête) | Date du scan | Date & Heure | — (`x_studio_date_scan`) |
| `x_fiche_appel_scan` | Date de la fiche | Date | — (`x_studio_date_fiche`) |
| `x_fiche_appel_scan` | Agent | Texte | — (`x_studio_agent`) |
| `x_fiche_appel_scan` | Nb d'appels | Entier | — (`x_studio_nb_appels`) |
| `x_fiche_appel_scan` | Hash anti-doublon | Texte | — (`x_studio_hash_dedup`) |
| `x_fiche_appel_scan` | Lignes | One2many → `x_fiche_appel_ligne` | — (`x_studio_ligne_ids`) |
| `x_fiche_appel_scan` | Étiquette "scan" | Tags / texte / case à cocher | `ODOO_TAG_FIELD_APPEL` |
| `x_fiche_appel_scan` | Statut | Selection | `ODOO_STATUS_FIELD_APPEL` |
| `x_fiche_appel_ligne` | Fiche | Many2one → `x_fiche_appel_scan` | — (`x_studio_fiche_id`) |
| `x_fiche_appel_ligne` | Téléphone | Texte | — (`x_studio_telephone`) |
| `x_fiche_appel_ligne` | Code résultat | Texte | — (`x_studio_code_resultat`) |
| `x_fiche_appel_ligne` | Date de l'appel | Date | — (`x_studio_date_appel`) |

Sur `x_suivi_rdv_ocr`, l'option **"Activités"** (chatter) doit être activée dans Odoo Studio,
sinon la création d'activité échoue (la fiche est quand même créée ; l'erreur apparaît dans le
message de confirmation à l'écran).

### Google Sheets (mis en pause)

Google Sheets reste disponible dans le code (`routes/sheets.js`) au cas où vous voudriez y revenir :
il suffit de remettre `saveToSheets` / `/api/sheets/save` côté frontend (`public/assets/js/app.js`).

### 1. Créer un compte de service Google

1. Allez sur [console.cloud.google.com](https://console.cloud.google.com), créez un projet (ou
   utilisez un projet existant).
2. **APIs & Services → Library** → cherchez **"Google Sheets API"** → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service account**. Donnez-lui un nom
   (ex. `alpha-motors-ocr`), pas besoin de rôle particulier au niveau projet.
4. Ouvrez le compte de service créé → onglet **Keys → Add Key → Create new key → JSON**. Un
   fichier `.json` se télécharge — gardez-le, il contient tout ce qu'il faut.

Dans ce fichier JSON, récupérez deux valeurs :
- `client_email` → variable `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key` → variable `GOOGLE_PRIVATE_KEY` (collez-la telle quelle, avec les `\n`)

### 2. Créer et partager la feuille

1. Créez une feuille Google Sheets (vide, l'appli crée les onglets et les en-têtes toute seule).
2. Copiez son ID depuis l'URL : `https://docs.google.com/spreadsheets/d/`**`CET_ID`**`/edit`
   → variable `GOOGLE_SHEET_ID`.
3. **Partagez** cette feuille avec l'adresse `client_email` du compte de service (bouton
   "Partager", rôle **Éditeur**) — sans ça, l'API refusera l'écriture même avec une clé valide.

### 3. Variables à renseigner

```
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=...
```

L'appli crée automatiquement les onglets **"Suivi RDV"** et **"Fiche appel"** (ou les noms définis
dans `GOOGLE_SHEET_TAB_RDV` / `GOOGLE_SHEET_TAB_APPEL`) avec leurs en-têtes au premier enregistrement.

### Anti-doublon

Avant chaque enregistrement, l'appli relit l'onglet Google Sheets concerné et ignore toute ligne
dont la clé **téléphone + date** existe déjà (colonnes "Date RDV" pour Suivi RDV, "Date fiche" pour
Fiche appel), y compris si le même fichier est envoyé deux fois. Les lignes ignorées sont listées
dans le message de confirmation.

Limite : si le téléphone est identique mais que la date n'a pas été détectée/saisie (champ vide des
deux côtés), la ligne sera quand même considérée comme un doublon. Remplissez la date si vous voulez
enregistrer volontairement deux fiches pour le même numéro sans date précise.

## Configurer les modèles Odoo (en pause pour le moment)

Le code suppose deux modèles Odoo Studio (comme `x_fiche_de_presenceocr` dans le projet d'origine)
que vous devez créer, un par type de document :

| Type          | Modèle par défaut     | Variable d'env      |
|---------------|------------------------|----------------------|
| Suivi des RDV | `x_suivi_rdv_ocr`      | `ODOO_MODEL_RDV`     |
| Fiche appel   | `x_fiche_appel_ocr`    | `ODOO_MODEL_APPEL`   |

Pour chaque modèle, créez dans Odoo Studio les champs suivants et vérifiez que leurs **noms
techniques** correspondent à ceux de `config.js` (section `DOCUMENT_TYPES.*.fields`) :

**Suivi des RDV**
- `x_studio_telephone` (texte)
- `x_studio_client` (texte)
- `x_studio_date_rdv` (date)
- `x_studio_heure_rdv` (texte)
- `x_studio_ville` (texte)
- `x_studio_commentaire` (texte)
- `x_studio_agent` (texte)

**Fiche appel**
- `x_studio_telephone` (texte)
- `x_studio_code_resultat` (texte)
- `x_studio_date_appel` (date)
- `x_studio_agent` (texte)

Si vos noms de champs Odoo sont différents, changez-les dans `config.js` — pas besoin de toucher
au reste du code. Vous pouvez vérifier la correspondance une fois le serveur lancé via :

```
GET /api/odoo/fields?docType=suivi_rdv
GET /api/odoo/fields?docType=fiche_appel
```

## Ajouter un troisième type de document

Tout se passe dans `config.js`, bloc `DOCUMENT_TYPES` : ajoutez une entrée avec son `odooModel`,
sa correspondance `fields`, ses `columns` (pour l'interface) et son `schemaHint` (le JSON que
Mistral doit produire). Aucune autre modification n'est nécessaire : l'interface et les routes
sont génériques.

## Limites connues

- L'OCR sur écriture manuscrite dense (ex. longues listes de numéros au stylo) reste faillible.
  L'écran de vérification (étape 3) est volontairement là pour ça — ne pas enregistrer sans relire.
- L'anti-doublon est simple (téléphone + date) ; adaptez `dedupeKeys` dans `config.js` si votre
  besoin est différent.
