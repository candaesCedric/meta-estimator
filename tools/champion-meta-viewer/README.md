# Champion Meta Viewer (HTML/JS)

UI locale pour afficher et trier les stats de `databases/champion-meta/stats.json`.

## Démarrage

Depuis la racine `pokemon-showdown`:

```bash
python3 -m http.server 8000
```

Puis ouvre:

- http://localhost:8000/tools/champion-meta-viewer/

## Utilisation

- `Charger stats.json par défaut`: lit `../../databases/champion-meta/stats.json`
- `Charger un autre JSON`: permet de charger n'importe quel export de stats
- Clic sur les en-têtes de colonnes: tri asc/desc
- Champ `Rechercher`: filtre Pokemon + Teams
