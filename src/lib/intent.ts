// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Ce que demande le message : agir sur l'ordinateur (mode Agent) ou chercher sur Internet (Web).
// Sert à activer ces modes tout seuls à l'envoi (au clavier comme à la voix) et à les allumer pendant la saisie.

// « ouvre / lance / ferme … », « crée un dossier », « mets de la musique », « fais une capture d'écran »…
const ACTION =
  /(?:^|[^\p{L}])(?:ouvr\w*|lance[rsz]?|ferme[rsz]?|quitte[rsz]?|d[ée]marre[rsz]?|ex[ée]cute[rsz]?|installe[rsz]?|d[ée]sinstalle[rsz]?|supprime[rsz]?|d[ée]place[rsz]?|renomme[rsz]?|copie[rsz]?\s+(?:le|les|ce)\s+fichier|range[rsz]?\s+(?:mes|le|les)|cr[ée]+e?r?\s+(?:un|le|des|une)\s+(?:dossier|fichier|projet)|travaille[rsz]?\s+dans|mets?\s+(?:de\s+la\s+|la\s+)?musique|capture\s+d['’]?[ée]cran|liste[rsz]?\s+(?:les\s+)?(?:fichiers|dossiers))(?=$|[^\p{L}])/iu

// « cherche / recherche », météo, actualité, prix, horaires, résultats sportifs, « sur internet »…
const WEB =
  /(?:^|[^\p{L}])(?:cherche[rsz]?|recherche[rsz]?|trouve[rsz]?[- ]moi|google|sur\s+(?:internet|le\s+web|le\s+net)|en\s+ligne|m[ée]t[ée]o|quel\s+temps|temp[ée]rature|pr[ée]visions?|actu(?:alit[ée]s?)?|news|derni[èe]res?\s+(?:nouvelles|infos)|aujourd['’]hui|cette\s+semaine|ce\s+week-?end|prix\s+(?:de|du|des)|combien\s+co[ûu]te|cours\s+(?:de|du)\s+(?:la\s+)?(?:bourse|bitcoin|l['’]action)|horaires?|score|r[ée]sultats?\s+(?:du|des|de\s+la)|qui\s+a\s+gagn[ée]|quand\s+sort|sortie\s+(?:de|du)|derni[èe]re\s+version)(?=$|[^\p{L}])/iu

// « teste ce programme », « compile », « dans le labo », « sous Windows / Linux / Android », « .exe / .apk »…
const LAB =
  /(?:^|[^\p{L}])(?:labos?|laboratoire|bac\s+à\s+sable|sandbox|machine\s+virtuelle|[ée]mulateur|t[ée]l[ée]phone\s+virtuel|compile[rsz]?|compilation|d[ée]bogue[rsz]?|teste[rsz]?\s+(?:ce|cette|mon|ma|mes|le|la|les|un|une|l['’])\s*(?:code|programme|script|appli\w*|logiciel|projet|site|jeu|fonction|exe|apk|outil|bot)|ex[ée]cute[rsz]?\s+(?:ce|cette|mon|ma|le|la|un|une)\s+(?:code|programme|script|fichier|fonction)|(?:sous|sur|dans|pour)\s+(?:un\s+)?(?:linux|windows|ubuntu|android)|appli(?:cation)?\s+android|\S+\.(?:exe|apk|msi)|apk)(?=$|[^\p{L}])/iu

export const wantsAction = (text: string) => ACTION.test(text)
export const wantsWeb = (text: string) => WEB.test(text)
export const wantsLab = (text: string) => LAB.test(text)
