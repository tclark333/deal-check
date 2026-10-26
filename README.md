# Deal Check

Which size is the better deal? Enter the price of each size (it starts on a 750 mL and a 1.75 L
bottle) and it shows which is cheaper per unit, by how much, and what you save. Sizes and units
can be changed (volume, weight or a count), and up to four sizes compared.

Use it at https://tclark333.github.io/deal-check/. On a phone, "Add to Home Screen" (iPhone:
Share menu; Android: the browser menu) puts it on the home screen like an app, and it works
offline after the first visit.

## How it's built

One static page, no build step: `index.html` (everything), `sw.js` (offline cache),
`manifest.webmanifest` and the icons. GitHub Pages serves the `main` branch, so pushing to `main`
publishes it.

When changing the files, bump `CACHE` in `sw.js`. Phones with it installed get the update the
second time they open it (the first open still shows the saved copy).
