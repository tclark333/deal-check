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

"Scan tags" above the cards is the one camera button. It opens the camera inside the app and keeps
it open: fit a shelf tag in the box and tap anywhere, and its price, size and unit go into the next
card. Tap again for the next tag (up to four), and "Done" closes it; one tag is one tap and Done.
Only the box (plus a margin) is sent, at up to 1568 px, so each tag is its own full-detail picture.

Where a scan starts: if some cards have a price and some don't, it fills the ones without, so a bad
read is redone by clearing that price and scanning again, and one price can be typed while the other
is scanned. If every card has a price (or none does), the first tap starts a fresh comparison.

"Phone camera" in the camera view, or a browser that can't open the camera in a page or a refused
camera permission, uses the phone's own camera app instead, one tag per press (that whole photo is
shrunk to 1568 px). The photo goes to a small Cloudflare Worker (`worker/`), which asks Claude Haiku to read
it, checks the reading against the tag's printed unit price, and answers with JSON. A "2 for $5" or
buy-one-get-one deal comes back as the price of one at the deal, with a note saying how many to buy.
Grocery tags print "OZ" on drinks too, so when ounces are compared with a volume (fl oz, mL, L)
the app counts them as fluid ounces and says so. The Worker holds
the Anthropic API key as a secret, so it never appears in this public page. It only answers this
site, and limits scans to 10 a minute per phone and 300 a day overall. Without signal, or if a
scan fails, typing works as before.

Worker: `cd worker && npm install && npm test && npm run deploy` (needs `npx wrangler login`).
