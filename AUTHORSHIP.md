# Paternité de Lumen

**Lumen est conçu et développé par [Nixovel](https://github.com/Nixovel).**
Dépôt officiel : https://github.com/Nixovel/Ia-local · © 2026 Nixovel, tous droits réservés ([LICENSE](LICENSE)).

Ce document rassemble les preuves que Lumen est l'œuvre de Nixovel, pour qu'une copie — même renommée, restructurée
ou réécrite par une IA — puisse être reconnue et retirée. Aucune protection technique n'empêche de recopier du code ;
ce qui compte, c'est de pouvoir montrer qui l'a publié en premier et sous quel nom. C'est ce que réunit ce dossier.

## 1. Historique daté et public

- Chaque commit est signé du nom **Nixovel** et horodaté ; GitHub enregistre la date de chaque envoi.
- Les « forks » GitHub restent reliés au dépôt d'origine (graphe du réseau), ce qui montre d'où vient le code.
- Première publication : **23 novembre 2026**. Le projet est né d'une maquette Figma (« Lumen — Interface IA locale
  (Premium) »), puis de l'application React/Vite, développée en novembre 2026.

## 2. Empreinte de l'œuvre

[`AUTHORSHIP.sha256`](AUTHORSHIP.sha256) contient l'empreinte SHA-256 de chacun des fichiers publiés. L'empreinte globale
(SHA-256 de cette liste) identifie de façon unique l'état exact du code à la date de publication :

| Date | Version | Fichiers | Empreinte globale (SHA-256) |
| --- | --- | --- | --- |
| 2026-11-23 | 1.0 — première publication | 63 | `543c1cc2599a2a2dfb5f13065e458870fcbe862706d635979f43f86f376e88cd` |

Vérifier : `npm run fingerprint -- --check`. Un fichier copié tel quel a la même empreinte que l'original ; la liste
permet de repérer en quelques secondes les fichiers repris dans un autre projet.

## 3. Mentions intégrées au logiciel

- [LICENSE](LICENSE) (tous droits réservés) et un en-tête « © 2026 Nixovel » en tête de chaque fichier source ;
- `package.json` (auteur, licence, dépôt) et `index.html` (méta « author » et « copyright ») ;
- dans l'application : Réglages → **À propos**, « par Nixovel » sur l'écran d'accueil, signature dans la console
  du navigateur ;
- dans chaque fichier JavaScript compilé : `/*! Lumen — © 2026 Nixovel — https://github.com/Nixovel/Ia-local … */` ;
- dans les installateurs (`install.sh`, `install.ps1`) : bannière d'auteur et adresse du dépôt officiel.

## 4. Une œuvre reconnaissable

Au-delà du code, Lumen est une combinaison originale de choix de conception, protégée en tant que telle : maquette et
design system « Lumen » (thème sombre, accent ambre) ; catalogue de modèles par usage en versions standard et non censurées ;
classement « Fluide / Possible / Trop lourd » selon le matériel détecté ; agent qui agit sur l'ordinateur via un pont
local sécurisé (jeton, validations) ; activation automatique Agent / Web / Réflexion selon la demande ; conversation
vocale façon Jarvis dont le texte s'affiche au rythme de la voix ; dessin d'images en SVG ; installateurs
multi-plateformes avec diagnostic. Une réécriture qui reprend cette architecture, ces fonctionnalités ou cette interface
reste une œuvre dérivée (LICENSE, §2 d).

## 5. Renforcer la preuve (conseillé)

- **e-Soleau (INPI)** : dépôt en ligne d'une archive du dépôt (zip) et de `AUTHORSHIP.sha256` — preuve de date reconnue
  en France, environ 15 € pour 5 ans (renouvelable). https://www.inpi.fr
- **Commits signés** : ajouter une clé de signature au compte Nixovel pour obtenir le badge « Verified » sur GitHub.
- **À chaque nouvelle version** : `npm run fingerprint`, puis ajouter une ligne au tableau ci-dessus et committer.

## 6. En cas de copie

1. Garder les preuves : liens, captures datées, fichiers de la copie (comparer avec `AUTHORSHIP.sha256` ou un diff).
2. Demander le retrait ou la mention de l'auteur à la personne concernée.
3. Sur GitHub : demande de retrait DMCA — https://github.com/contact/dmca (le code « tous droits réservés » est protégé par
   le droit d'auteur) ; même démarche auprès des autres hébergeurs et magasins d'applications.
4. Si nécessaire : constat (commissaire de justice) et avocat.

Contact : https://github.com/Nixovel
