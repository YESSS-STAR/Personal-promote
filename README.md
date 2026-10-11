# Personal-promote

A school candy pre-order storefront for **Airheads**, deployed at
[boosttup.xyz](https://boosttup.xyz) via GitHub Pages.

## Pages

| File         | Purpose                                        |
| ------------ | ---------------------------------------------- |
| `index.html` | Customer storefront (browse, order, checkout)  |
| `ref.html`   | User dashboard (favorites, spend, rewards) + referrals |
| `admin.html` | Staff admin panel (orders, stock, coupons, marketing) |
| `CNAME`      | Custom domain for GitHub Pages                 |

## Shared modules

| File                   | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `order-utils.js`       | Restock maths for cancelled orders (flavours, free bars, bundles, rebate claw-back) |
| `pricing-strategies.js`| Psychological pricing, volume ladder, decoy set, rebates, messaging copy |
| `streak-utils.js`      | Weekly order streaks: streak maths, milestone rewards, messaging |

All three are plain `<script>` files (no build step) that also export via
`module.exports`, so the Node test suite exercises the same code the browser runs.

## Stack

- Static HTML / CSS / vanilla JS
- Firebase Realtime Database (`airheader-6ec67`)

## Design system

All three pages share one token set, defined at the top of each `<style>` block.
`ref.html` and `admin.html` keep their original variable names as aliases pointing
at the new tokens, so the whole panel re-skins without rewriting the CSS below.

**The governing rule: hue means flavour, or it means money. Nothing else here
gets a colour.** Structure comes from hairlines and one rack container, not from
cards and drop shadows.

| Token group | Values (light → dark) | Used for |
| ----------- | --------------------- | -------- |
| Paper | `#FFFFFF` `#F1F1F4` `#E7E7EC` → `#0A0A0C` `#16161A` `#1F1F24` | Page, raised panels, tracks |
| Line | `#E3E3E8` `#CBCBD3` → `#2A2A31` `#3A3A43` | Hairlines; the rack is built from these |
| Ink | `#000000` `#5F5F66` `#8C8C94` → `#FFFFFF` `#A6A6B0` `#7C7C86` | Text, borders, currency |
| Money | `#0B7A45` → `#3ED07E` | Savings, rebate, streak qualified |
| Alert / warn | `#B3141B` `#8A5A00` → `#FF6B6B` `#E0A458` | Sold out, low stock, pending |
| Block | `#000000` on `#FFFFFF` → `#26262E` on `#FFFFFF` | Inverted surfaces: hero, selected row, primary button, cart bar |

The six flavour hues (`FLAVOR_COLORS`, mirrored in `index.html` and `ref.html`)
are the only other colour in the product. A flavour spine appears on every
surface where a flavour is named — the rack, the cart lines, the cross-sell, the
favourite-flavours list, and the bundle spine, which is built as hard-edged bands
of its own component colours so a pack's recipe is legible at a glance.

Type is **Archivo** for everything, with **Archivo Black** reserved for money and
display headings — anything with a `$` in it gets the display face and tabular
figures so columns of prices line up.

The main layout move is that the flavour list is **one rack**, not six cards:
a single hairline container whose rows are separated by 1px rules, with the
flavour colour as a stretched spine down the left edge. A row that is in the cart
inverts to the block colour, so "in your order" is visible from the grid without
reading a number.

## Behaviour worth knowing

### Cancelling an order returns its stock

Cancelling an order in the admin panel adds its quantities back to inventory:

- plain flavour lines return their quantity
- free reward bars are returned too (they were deducted from real stock)
- bundles return each component × the number of bundles bought, and the bundle's
  `soldCount` is released so a `maxSold` limit frees up again
- any rebate store credit paid out for that order is clawed back

The restock is **idempotent**: the `stockRestored` flag on the order is claimed
before the stock transactions run, so two admins approving the same cancellation
(or a retry after a dropped connection) can never credit the stock back twice.

### Psychological pricing & marketing strategies

Calibrated on one concrete reference product: an **Airheads bar (any flavour) with
a buy price of about $0.61**. The admin **Marketing** tab derives everything from
that cost:

| Strategy              | Default behaviour                                            |
| --------------------- | ------------------------------------------------------------ |
| Charm pricing         | Snaps targets to `.25/.49/.75/.95/.99` → $0.99 / **$1.25** / $1.75 |
| Anchoring             | Shows a struck-through "was" price + the saving on each card |
| Volume ladder         | 3 bars → 5% off, 5 → 10%, 10 → 15%, with a "add N more" nudge |
| Decoy option set      | 1 / 3 / 6 bars where the 3-bar option has no per-bar saving   |
| Tiered rebate         | $3 → 5%, $5 → 8%, $8 → 12% back as store credit (capped at $1.50) |
| Scarcity urgency      | "Only 4 left" once stock drops below the threshold            |
| Social proof          | "N sold today" badge, hidden until the number is worth showing |

Rebates are paid as **store credit, not a discount** — it reads as a reward and
brings the buyer back — and at the default $1.25 shelf price against a $0.61 cost
the shop still keeps a healthy margin after the top rebate tier.

The admin Marketing tab also renders the full strategy playbook (tactic, why it
works, how it is wired in here) and can push the recommended shelf price to every
flavour in one click.

### Growing the average order

Ordered by impact per unit of effort. **Implemented** means it is live in
`index.html` today; the rest are recommendations with the hook they'd use.

| # | Lever | Rank | Status |
| - | ----- | ---- | ------ |
| 1 | Volume ladder (3/5/10 bars → 5/10/15%) with a "add N more bars" nudge on the bill | Highest — pure quantity push, no discount given away until the tier is hit | **Implemented** |
| 2 | Anchoring (struck-through "was" + "Save $X") on every flavour row | Raises the perceived value of the base price, so a second bar feels cheap | **Implemented** |
| 3 | Bundles with a computed per-bar price and a real "Save $X" (hidden when the pack isn't actually cheaper) | Packs are the single biggest step up in units per order | **Implemented** |
| 4 | Cross-sell rack in the cart ("Goes well with your order") | Cheap, and it lands at the moment of highest intent | **Implemented** |
| 5 | Tiered rebate as store credit, shown mid-cart with the next tier's threshold | Converts one big order into a repeat order | **Implemented** |
| 6 | Free-bar reward at a spend threshold (spin wheel) | Adds a unit without cutting price | **Implemented** |
| 7 | Weekly streak with milestone rewards | Lifts order *frequency* rather than order size; compounds | **Implemented** |
| 8 | Decoy option set (1 / 3 / 6 bars, priced by the engine) | The 3-bar middle is the classic push-to-middle — but it is only used in the admin preview, because uploading priced packs from it needs the money path to change too | Recommendation |
| 9 | "Frequently bought together" from real co-purchase history | Strictly better than the price-ranked cross-sell once there are enough orders; needs an aggregation over `orders` | Recommendation |
| 10 | A pack-only flavour, or a seasonal pack | Creates a reason to buy a pack rather than a bar | Recommendation |

### Growing profit

| # | Lever | Rank | Status |
| - | ----- | ---- | ------ |
| 1 | Rebate paid as store credit (capped at $1.50) rather than a price cut | Highest — it costs nothing until the customer comes back, and it is capped | **Implemented** |
| 2 | Volume discounts that never reach the per-bar margin: the ladder tops out at 15% off a $1.25 bar against a $0.61 cost | Discounts are bounded by the engine, not by whoever is on the stall | **Implemented** |
| 3 | Cross-sell ranked by shelf price, which — because every bar costs the same to buy in — is also ranked by margin | Puts the highest-margin bars in front of the buyer at the point of decision | **Implemented** |
| 4 | Charm pricing on every price the admin pushes | `.25/.49/.75/.95/.99` endings measurably out-convert round numbers | **Implemented** |
| 5 | Scarcity ("Only 4 left") and social proof ("N sold today"), both behind thresholds so they never lie | Urgency without discounting | **Implemented** |
| 6 | Cash on collection, with the exact amount restated on the confirmation sheet | Avoids card fees entirely and removes the "how much do I bring" drop-off | **Implemented** |
| 7 | Removing checkout friction: name and class are remembered between orders, and codes/credits move into a collapsed "Have a code or credit?" instead of blocking the path to the button | Every field between intent and the button costs orders | **Implemented** |
| 8 | A cost-per-flavour table instead of one reference cost | Would let the admin spot a flavour that is actually thin once its own buy price is known | Recommendation |
| 9 | Raise the shelf price on the two best sellers by one charm step ($1.25 → $1.49) and watch a fortnight | Highest-leverage pricing move, but it needs real sell-through data before committing | Recommendation |
| 10 | A "buy 5, get the 6th at cost" case deal aimed at one class or a form teacher | Sells volume in one transaction, in a school where cash handling is the bottleneck | Recommendation |

## Tests

```sh
npm test          # or: node tests/run-tests.js
```

73 assertions covering the restock maths (including the real restock path driven
against an in-memory fake database), every pricing/rebate strategy, the streak
maths and milestone rewards, and static checks that each page's inline JavaScript
still parses and is wired up.

### Optional headless UI check

```sh
python -m http.server 8123      # in one terminal
npm run test:ui                 # in another
```

Loads the real `index.html` and `admin.html` in headless Chrome, stubs Firebase
with in-memory data, and drives the actual page code: adding to the cart, the
cart sheet totals, placing an order, and clicking the real **Cancel** button.
50 checks. Requires a local Chrome/Edge/Chromium (`CHROME_PATH` to override
detection), so it is opt-in and not part of `npm test`.

## Local preview

Open any page directly in a browser, or serve the folder:

```sh
python -m http.server 8000
```
