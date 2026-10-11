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

Both are plain `<script>` files (no build step) that also export via
`module.exports`, so the Node test suite exercises the same code the browser runs.

## Stack

- Static HTML / CSS / vanilla JS
- Firebase Realtime Database (`airheader-6ec67`)

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

## Tests

```sh
npm test          # or: node tests/run-tests.js
```

54 assertions covering the restock maths (including the real restock path driven
against an in-memory fake database), every pricing/rebate strategy, and static
checks that each page's inline JavaScript still parses and is wired up.

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
