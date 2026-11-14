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

## Scanning a shelf tag

The camera button beside each price takes a picture of the shelf tag and fills in the price, size
and unit. It opens the camera inside the app: fit the tag in the box and tap anywhere. Only the box
(plus a margin) is sent, at up to 1568 px. "Phone camera" in that view, or a browser that can't
open the camera in a page or a refused camera permission, uses the phone's own camera app instead
(that whole photo is shrunk to 1568 px). "Scan several tags" above the cards keeps the camera open: each tap reads the next tag into the next card (the first tap starts a fresh comparison), up to four, and "Done" closes it. Each tag is still its own full-detail picture. Without the in-app camera, each press of it reads one tag into the next empty card. The photo goes to a small Cloudflare Worker (`worker/`), which asks Claude Haiku to read
it, checks the reading against the tag's printed unit price, and answers with JSON. A "2 for $5" or
buy-one-get-one deal comes back as the price of one at the deal, with a note saying how many to buy.
Grocery tags print "OZ" on drinks too, so when ounces are compared with a volume (fl oz, mL, L)
the app counts them as fluid ounces and says so. The Worker holds
the Anthropic API key as a secret, so it never appears in this public page. It only answers this
site, and limits scans to 10 a minute per phone and 300 a day overall. Without signal, or if a
scan fails, typing works as before.

Worker: `cd worker && npm install && npm test && npm run deploy` (needs `npx wrangler login`).
