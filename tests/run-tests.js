/**
 * tests/run-tests.js
 * ---------------------------------------------------------------------------
 * Verification suite for the two changes:
 *
 *   1. Cancelling an order returns its quantities to inventory stock
 *      (order-utils.js)
 *   2. Psychological pricing + rebate strategies behave as documented
 *      (pricing-strategies.js)
 *
 * Run with:  node tests/run-tests.js
 *
 * Deliberately dependency-free - plain `assert`, no test framework, so it runs
 * anywhere Node is available.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const OrderUtils = require(path.join(__dirname, '..', 'order-utils.js'));
const Pricing = require(path.join(__dirname, '..', 'pricing-strategies.js'));

let passed = 0;
let failed = 0;
const failures = [];

// Tests are queued and then run in order, so async ones (the database
// integration tests) can be awaited without reordering the output.
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

function group(title) {
  queue.push({ title });
}

async function runAll() {
  for (const item of queue) {
    if (item.title) {
      console.log(`\n${item.title}`);
      continue;
    }
    try {
      await item.fn();
      passed++;
      console.log(`  \u2713 ${item.name}`);
    } catch (err) {
      failed++;
      failures.push({ name: item.name, err });
      console.log(`  \u2717 ${item.name}`);
      console.log(`      ${err.message}`);
    }
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(({ name, err }) => console.log(`  - ${name}\n    ${err.message}`));
    process.exit(1);
  }
}

// ===========================================================================
// CHANGE 1 - stock is returned to inventory when an order is cancelled
// ===========================================================================

group('Change 1: restock on cancellation');

test('a plain flavour line returns its quantity to that flavour', () => {
  const items = [{ flavor: 'Orange', qty: 3, price: 1.25 }];
  assert.deepStrictEqual(OrderUtils.collectStockRestoration(items), { Orange: 3 });
});

test('multiple flavours are each restored independently', () => {
  const items = [
    { flavor: 'Orange', qty: 2, price: 1.25 },
    { flavor: 'Grape', qty: 5, price: 1.25 }
  ];
  assert.deepStrictEqual(OrderUtils.collectStockRestoration(items), { Orange: 2, Grape: 5 });
});

test('the same flavour on two lines is summed, not overwritten', () => {
  const items = [
    { flavor: 'Cherry', qty: 2, price: 1.25 },
    { flavor: 'Cherry', qty: 1, price: 0.99, promo: true }
  ];
  assert.deepStrictEqual(OrderUtils.collectStockRestoration(items), { Cherry: 3 });
});

test('free reward units are restored - they came out of real stock', () => {
  const items = [{ flavor: 'Watermelon', qty: 2, price: 0, free: true }];
  assert.deepStrictEqual(OrderUtils.collectStockRestoration(items), { Watermelon: 2 });
});

test('bundle lines restore every component multiplied by bundle count', () => {
  const items = [{
    bundle: 'b1',
    name: 'Taster pack',
    qty: 3,
    price: 4.5,
    components: { Orange: 2, Grape: 1 }
  }];
  assert.deepStrictEqual(OrderUtils.collectStockRestoration(items), { Orange: 6, Grape: 3 });
});

test('a mixed order (flavours + free + bundle) is restored in full', () => {
  const items = [
    { flavor: 'Orange', qty: 4, price: 1.25 },
    { flavor: 'Grape', qty: 1, price: 0, free: true },
    { bundle: 'b1', name: 'Pack', qty: 2, price: 4.5, components: { Orange: 1, Cherry: 3 } }
  ];
  assert.deepStrictEqual(
    OrderUtils.collectStockRestoration(items),
    { Orange: 6, Grape: 1, Cherry: 6 }
  );
  assert.strictEqual(OrderUtils.totalRestoredUnits(OrderUtils.collectStockRestoration(items)), 13);
});

test('malformed lines and junk quantities are ignored rather than corrupting stock', () => {
  const items = [
    null,
    'not an object',
    { flavor: 'Orange', qty: 0 },
    { flavor: 'Orange', qty: -5 },
    { flavor: 'Orange', qty: 'abc' },
    { qty: 4 },
    { flavor: '', qty: 2 },
    { bundle: 'b1', qty: 2, components: { Grape: 0 } }
  ];
  assert.deepStrictEqual(OrderUtils.collectStockRestoration(items), {});
});

test('a missing/!array items field is handled without throwing', () => {
  assert.deepStrictEqual(OrderUtils.collectStockRestoration(undefined), {});
  assert.deepStrictEqual(OrderUtils.collectStockRestoration(null), {});
  assert.deepStrictEqual(OrderUtils.collectStockRestoration({}), {});
});

test('bundle sold-counts are released so maxSold slots free up again', () => {
  const items = [
    { bundle: 'b1', qty: 2, components: { Orange: 1 } },
    { bundle: 'b2', qty: 1, components: { Grape: 1 } },
    { flavor: 'Cherry', qty: 9 }
  ];
  assert.deepStrictEqual(OrderUtils.collectBundleRestoration(items), { b1: 2, b2: 1 });
});

// --- end-to-end: buy, then cancel, and the shelf is exactly as it was --------

test('end-to-end: stock after a cancelled order equals stock before it', () => {
  const before = {
    Orange: { price: 1.25, stock: 20 },
    Grape: { price: 1.25, stock: 12 },
    Cherry: { price: 1.25, stock: 8 },
    Watermelon: { price: 1.25, stock: 5 }
  };

  // What checkout does: reserve stock per flavour (index.html transactions).
  const combinedNeeds = { Orange: 5, Grape: 1, Cherry: 4, Watermelon: 2 };
  const afterCheckout = {};
  Object.keys(before).forEach((flavor) => {
    afterCheckout[flavor] = {
      price: before[flavor].price,
      stock: before[flavor].stock - (combinedNeeds[flavor] || 0)
    };
  });

  // The order that checkout wrote. It accounts for every reserved unit except
  // Watermelon, which is deliberately left reserved-but-uncancelled below to
  // prove the maths is a real add-back, not a "reset to before" cheat.
  const order = {
    items: [
      { flavor: 'Orange', qty: 3, price: 1.25 },
      { flavor: 'Grape', qty: 1, price: 0, free: true },
      { bundle: 'b1', name: 'Pack', qty: 2, price: 4.5, components: { Orange: 1, Cherry: 2 } }
    ]
  };
  // 3 Orange + (2 bundles x 1 Orange) = 5 Orange, 1 free Grape, 2 x 2 = 4 Cherry
  const restoration = OrderUtils.collectStockRestoration(order.items);
  assert.deepStrictEqual(restoration, { Orange: 5, Grape: 1, Cherry: 4 });

  const restored = OrderUtils.applyRestoration(afterCheckout, restoration);
  assert.strictEqual(restored.Orange.stock, before.Orange.stock);
  assert.strictEqual(restored.Grape.stock, before.Grape.stock);
  assert.strictEqual(restored.Cherry.stock, before.Cherry.stock);
  assert.strictEqual(
    restored.Watermelon.stock,
    before.Watermelon.stock - 2,
    'stock that was never part of the cancelled order must stay reserved'
  );
});

test('applyRestoration does not mutate the inventory it is given', () => {
  const inventory = { Orange: { price: 1.25, stock: 4 } };
  const next = OrderUtils.applyRestoration(inventory, { Orange: 6 });
  assert.strictEqual(inventory.Orange.stock, 4, 'input must be untouched');
  assert.strictEqual(next.Orange.stock, 10);
});

test('applyRestoration creates an entry for a flavour missing from the snapshot', () => {
  const next = OrderUtils.applyRestoration({}, { BlueRaspberry: 2 });
  assert.strictEqual(next.BlueRaspberry.stock, 2);
});

test('the restock flag makes a cancellation idempotent', () => {
  assert.strictEqual(OrderUtils.isRestored({ stockRestored: true }), true);
  assert.strictEqual(OrderUtils.isRestored({ stockRestored: false }), false);
  assert.strictEqual(OrderUtils.isRestored({}), false);
  assert.strictEqual(OrderUtils.isRestored(null), false);
});

test('money balances stay exact to the cent (float drift is rounded away)', () => {
  assert.strictEqual(OrderUtils.roundMoney(5.02 - 1.02), 4);
  assert.strictEqual(OrderUtils.roundMoney(0.1 + 0.2), 0.3);
  assert.strictEqual(OrderUtils.roundMoney(NaN), 0);
});

test('rebate credit handed out at checkout is clawed back on cancellation', () => {
  const order = {
    rebateAmount: 1.02,
    rebateAwarded: true,
    rebateAwardedTo: { name: 'Aisyah', class: 'Sec 2 Amanah' }
  };
  const reversal = OrderUtils.collectRebateReversal(order);
  assert.strictEqual(reversal.amount, 1.02);
  assert.strictEqual(reversal.path, 'students/Aisyah/Sec 2 Amanah/credit');
});

test('rebate reversal is skipped when there is nothing to claw back', () => {
  assert.strictEqual(OrderUtils.collectRebateReversal(null), null);
  assert.strictEqual(OrderUtils.collectRebateReversal({ rebateAwarded: true, rebateAmount: 1 }), null, 'no account');
  assert.strictEqual(
    OrderUtils.collectRebateReversal({ rebateAwarded: true, rebateAmount: 1, rebateAwardedTo: { name: 'A', class: 'B' }, rebateReversed: true }),
    null,
    'already reversed'
  );
  assert.strictEqual(
    OrderUtils.collectRebateReversal({ rebateAwarded: false, rebateAmount: 1, rebateAwardedTo: { name: 'A', class: 'B' } }),
    null,
    'never awarded'
  );
  assert.strictEqual(
    OrderUtils.collectRebateReversal({ rebateAwarded: true, rebateAmount: 0, rebateAwardedTo: { name: 'A', class: 'B' } }),
    null,
    'nothing earned'
  );
});

// ===========================================================================
// CHANGE 2 - psychological pricing and rebate strategies
// ===========================================================================

const COST = 0.61; // Airheads bar, buy price

group(`Change 2: pricing strategies (reference cost $${COST})`);

test('the reference product is the Airheads bar at ~$0.61', () => {
  assert.strictEqual(Pricing.REFERENCE_PRODUCT.buyPrice, 0.61);
  assert.ok(/Airheads/.test(Pricing.REFERENCE_PRODUCT.name));
});

test('charm pricing snaps a target up to a friendly ending', () => {
  assert.strictEqual(Pricing.charmPrice(1.22), 1.25);
  assert.strictEqual(Pricing.charmPrice(1.26), 1.49);
  assert.strictEqual(Pricing.charmPrice(1.0), 1.25);
  assert.strictEqual(Pricing.charmPrice(0.61), 0.75);
  assert.strictEqual(Pricing.charmPrice(2.4), 2.49);
});

test('charm pricing never returns a price below the target in "up" mode', () => {
  for (let cents = 5; cents <= 500; cents++) {
    const target = cents / 100;
    assert.ok(Pricing.charmPrice(target) >= target - 1e-9, `target ${target} was rounded down`);
  }
});

test('charm pricing "down" mode rounds to a deal-friendly total', () => {
  assert.strictEqual(Pricing.charmPrice(6.375, undefined, 'down'), 6.25);
  assert.ok(Pricing.charmPrice(6.375, undefined, 'down') <= 6.375);
});

test('charm pricing handles nonsense input without producing NaN', () => {
  assert.strictEqual(Pricing.charmPrice(0), 0);
  assert.strictEqual(Pricing.charmPrice(-3), 0);
  assert.strictEqual(Pricing.charmPrice(NaN), 0);
  assert.strictEqual(Pricing.charmPrice(undefined), 0);
});

test('the price ladder is charm-priced and margin-safe at cost $0.61', () => {
  const ladder = Pricing.priceLadder(COST);
  const byKey = Object.fromEntries(ladder.map((r) => [r.key, r]));

  assert.strictEqual(byKey.entry.price, 0.99);
  assert.strictEqual(byKey.regular.price, 1.25);
  assert.strictEqual(byKey.premium.price, 1.75);

  ladder.forEach((rung) => {
    assert.ok(rung.price > COST, `${rung.key} must be above cost`);
    assert.ok(rung.profit > 0, `${rung.key} must be profitable`);
    assert.ok(rung.marginPercent > 0 && rung.marginPercent < 100);
  });

  // The recommended shelf price clears a 50% margin.
  assert.ok(byKey.regular.marginPercent > 50, `regular margin was ${byKey.regular.marginPercent}%`);
  assert.strictEqual(byKey.regular.profit, 0.64);
});

test('the ladder is monotonic and each rung beats the one below it', () => {
  const ladder = Pricing.priceLadder(COST);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i].price > ladder[i - 1].price, 'prices must increase up the ladder');
    assert.ok(ladder[i].profit > ladder[i - 1].profit, 'profit must increase up the ladder');
  }
});

test('margin arithmetic is correct', () => {
  const m = Pricing.margin(1.25, COST);
  assert.strictEqual(m.profit, 0.64);
  assert.strictEqual(m.marginPercent, 51.2);
  assert.strictEqual(m.markupPercent, 104.92);
});

test('anchoring produces a "was" price above the real price plus a saving', () => {
  const a = Pricing.anchorPrice(1.25);
  assert.ok(a.anchor > a.price, 'anchor must sit above the price');
  assert.strictEqual(a.anchor, 1.75);
  assert.strictEqual(a.savings, 0.5);
  assert.ok(a.savingsPercent > 0 && a.savingsPercent < 100);
});

test('anchoring never collapses onto the price itself', () => {
  for (let cents = 5; cents <= 900; cents++) {
    const price = cents / 100;
    const a = Pricing.anchorPrice(price);
    assert.ok(a.anchor > price, `anchor for ${price} collapsed to ${a.anchor}`);
  }
});

test('volume discounts apply at the tier boundary, not one bar early', () => {
  const base = 6.25; // 5 bars at $1.25

  const at2 = Pricing.volumeDiscount(2, base);
  assert.strictEqual(at2.percent, 0);
  assert.strictEqual(at2.amount, 0);
  assert.strictEqual(at2.nextTier.qty, 3);
  assert.strictEqual(at2.unitsToNextTier, 1);

  const at3 = Pricing.volumeDiscount(3, base);
  assert.strictEqual(at3.percent, 5);
  assert.strictEqual(at3.amount, 0.31);

  const at5 = Pricing.volumeDiscount(5, base);
  assert.strictEqual(at5.percent, 10);
  assert.strictEqual(at5.amount, 0.63);

  const at10 = Pricing.volumeDiscount(10, 12.5);
  assert.strictEqual(at10.percent, 15);
  assert.strictEqual(at10.amount, 1.88);
  assert.strictEqual(at10.nextTier, null);
  assert.strictEqual(at10.unitsToNextTier, 0);
});

test('volume nudge copy tells the shopper exactly how far the next tier is', () => {
  assert.strictEqual(
    Pricing.volumeNudge(Pricing.volumeDiscount(2, 2.5)),
    'Add 1 more to unlock 5% off'
  );
  assert.strictEqual(
    Pricing.volumeNudge(Pricing.volumeDiscount(3, 3.75)),
    '5% off applied. Add 2 more for 10% off'
  );
  assert.strictEqual(
    Pricing.volumeNudge(Pricing.volumeDiscount(10, 12.5)),
    'Best volume price unlocked - 15% off'
  );
});

test('volume discount cannot exceed the subtotal it is applied to', () => {
  const v = Pricing.volumeDiscount(10, 4);
  assert.ok(v.amount <= 4);
});

test('the decoy ladder makes the large option the best value per bar', () => {
  const { options, decoyKey, recommendedKey } = Pricing.decoyLadder(1.25);
  const byKey = Object.fromEntries(options.map((o) => [o.key, o]));

  assert.strictEqual(decoyKey, 'mid');
  assert.strictEqual(recommendedKey, 'high');
  assert.strictEqual(byKey.single.price, 1.25);
  assert.strictEqual(byKey.mid.price, 3.75);
  assert.strictEqual(byKey.high.price, 6.25);

  // The whole point: the decoy has no per-bar saving, the hero option does.
  assert.strictEqual(byKey.mid.unitPrice, 1.25);
  assert.ok(byKey.high.unitPrice < byKey.mid.unitPrice, 'large pack must beat the decoy per bar');
  assert.ok(byKey.high.savingsVsSingle > 0);
});

test('rebates step up with spend and match the published tiers', () => {
  assert.strictEqual(Pricing.rebateForSpend(1.0).amount, 0);
  assert.strictEqual(Pricing.rebateForSpend(1.0).nextTier.minSpend, 3);

  const r3 = Pricing.rebateForSpend(3);
  assert.strictEqual(r3.rate, 5);
  assert.strictEqual(r3.amount, 0.15);

  const r5 = Pricing.rebateForSpend(5);
  assert.strictEqual(r5.rate, 8);
  assert.strictEqual(r5.amount, 0.4);

  const r8 = Pricing.rebateForSpend(8.5);
  assert.strictEqual(r8.rate, 12);
  assert.strictEqual(r8.amount, 1.02);
});

test('the rebate cap protects the margin on very large orders', () => {
  const r = Pricing.rebateForSpend(50);
  assert.strictEqual(r.amount, 1.5);
  assert.strictEqual(r.capped, true);
});

test('rebate nudge copy drives the next tier', () => {
  assert.strictEqual(
    Pricing.rebateNudge(Pricing.rebateForSpend(4)),
    'You earn $0.20 back. Spend $1.00 more for 8% back'
  );
  assert.strictEqual(
    Pricing.rebateNudge(Pricing.rebateForSpend(2)),
    'Spend $1.00 to earn 5% back as store credit'
  );
});

test('a rebate at the top tier still leaves the shop in profit', () => {
  const shelf = Pricing.priceLadder(COST).find((r) => r.key === 'regular').price; // 1.25
  const best = Pricing.rebateForSpend(10).rate; // 12
  const eff = Pricing.effectiveMargin(shelf, COST, best);

  assert.strictEqual(eff.netRevenue, 1.1);
  assert.ok(eff.profit > 0, 'rebate must not wipe out profit');
  assert.ok(eff.marginPercent > 40, `margin after rebate was ${eff.marginPercent}%`);
});

test('scarcity messaging escalates as stock falls', () => {
  assert.strictEqual(Pricing.scarcityMessage(20).level, 'ok');
  assert.strictEqual(Pricing.scarcityMessage(4).level, 'low');
  assert.strictEqual(Pricing.scarcityMessage(2).level, 'critical');
  assert.strictEqual(Pricing.scarcityMessage(0).level, 'out');
  assert.ok(/Only 2 left/.test(Pricing.scarcityMessage(2).text));
});

test('social proof stays hidden until the number is worth showing', () => {
  assert.strictEqual(Pricing.socialProofMessage(3), null);
  assert.strictEqual(Pricing.socialProofMessage(12).text, '12 sold today');
  assert.strictEqual(Pricing.socialProofMessage(0), null);
});

test('every strategy is documented in the playbook', () => {
  const keys = Pricing.PRINCIPLES.map((p) => p.key);
  ['charm', 'anchor', 'decoy', 'volume', 'rebate', 'scarcity', 'socialProof', 'reciprocity', 'commitment', 'bundling']
    .forEach((k) => assert.ok(keys.includes(k), `playbook is missing "${k}"`));
  Pricing.PRINCIPLES.forEach((p) => {
    assert.ok(p.name && p.tactic && p.why && p.example, `${p.key} is incompletely documented`);
  });
});

test('the orchestrator returns one coherent, affordable plan for the $0.61 bar', () => {
  const plan = Pricing.recommendStrategies(COST);

  assert.strictEqual(plan.reference.buyPrice, 0.61);
  assert.strictEqual(plan.charmPricing.shelfPrice, 1.25);
  assert.strictEqual(plan.priceLadder.length, 3);
  assert.strictEqual(plan.anchoring.anchor, 1.75);
  assert.ok(plan.decoy.options.length === 3);
  assert.ok(plan.rebate.tiers.length === 3);
  assert.ok(plan.principles.length >= 10);

  // Every rung and the rebate-adjusted margin must stay profitable.
  assert.ok(plan.affordability.atShelfPrice.profit > 0);
  assert.ok(plan.affordability.atBestRebateTier.profit > 0);
});

test('custom config overrides are honoured (a cheaper bulk buy price)', () => {
  const plan = Pricing.recommendStrategies(0.4);
  assert.strictEqual(plan.reference.buyPrice, 0.4);
  assert.ok(plan.charmPricing.shelfPrice < 1.25, 'cheaper cost should charm-price lower');
  assert.ok(plan.charmPricing.shelfPrice > 0.4);

  const custom = Pricing.rebateForSpend(10, { rebateTiers: [{ minSpend: 1, rate: 50 }], rebateCap: 100 });
  assert.strictEqual(custom.rate, 50);
  assert.strictEqual(custom.amount, 5);
});

// ===========================================================================
// Static verification of the pages that consume the two modules
// ===========================================================================

// ===========================================================================
// CHANGE 1 - the real cancellation path, run against an in-memory database
// ===========================================================================

group('Change 1 end-to-end: the production restock path, against a fake database');

/**
 * Minimal Firebase Realtime Database stand-in implementing exactly the surface
 * order-utils.restockOrder uses: ref(path).{once,set,transaction}.
 */
function makeFakeDb(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const keysOf = (p) => p.split('/').filter(Boolean);
  const getPath = (p) => keysOf(p).reduce((node, k) => (node && typeof node === 'object' ? node[k] : undefined), data);
  const setPath = (p, value) => {
    const keys = keysOf(p);
    let node = data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = clone(value);
  };

  return {
    _data: data,
    ref(p) {
      return {
        once: async () => ({ val: () => clone(getPath(p)) }),
        set: async (value) => { setPath(p, value); return { committed: true }; },
        transaction: async (fn) => {
          const current = clone(getPath(p));
          const next = fn(current);
          if (next === undefined) return { committed: false, snapshot: { val: () => current } };
          setPath(p, next);
          return { committed: true, snapshot: { val: () => clone(next) } };
        }
      };
    }
  };
}

/** The state a live shop would be in right after this order was placed. */
function seedAfterOrder() {
  return {
    inventory: {
      Orange: { price: 1.25, stock: 15 },
      Grape: { price: 1.25, stock: 7 },
      Cherry: { price: 1.25, stock: 4 },
      Watermelon: { price: 1.25, stock: 9 },
      'Blue Raspberry': { price: 1.25, stock: 11 },
      'White Mystery': { price: 1.25, stock: 6 }
    },
    bundles: {
      taster: { name: 'Taster pack', price: 4.5, soldCount: 2, maxSold: 10, components: { Orange: 1, Cherry: 2 } }
    },
    students: {
      Aisyah: { 'Sec 2 Amanah': { credit: 5.02, freeItems: 0 } }
    },
    orders: {
      order1: {
        name: 'Aisyah',
        className: 'Sec 2 Amanah',
        status: 'pending',
        total: 11.5,
        subtotal: 12.5,
        volumeDiscount: 0.63,
        rebateAmount: 1.02,
        rebateAwarded: true,
        rebateAwardedTo: { name: 'Aisyah', class: 'Sec 2 Amanah' },
        items: [
          { flavor: 'Orange', qty: 4, price: 1.25 },
          { flavor: 'Grape', qty: 2, price: 1.25 },
          { flavor: 'Watermelon', qty: 1, price: 0, free: true },
          { bundle: 'taster', name: 'Taster pack', qty: 2, price: 4.5, components: { Orange: 1, Cherry: 2 } }
        ]
      }
    }
  };
}

test('cancelling an order returns every unit to stock, frees bundle slots and claws back the rebate', async () => {
  const db = makeFakeDb(seedAfterOrder());
  const order = db._data.orders.order1;

  const result = await OrderUtils.restockOrder('order1', order, db);

  assert.strictEqual(result.restored, true);
  // 4 + 2 Orange + 1 free Watermelon + (2 x 2) Cherry = 6 + 2 + 1 + 4 = 13 units
  assert.strictEqual(result.units, 13);
  assert.deepStrictEqual(result.flavors, { Orange: 6, Grape: 2, Watermelon: 1, Cherry: 4 });
  assert.strictEqual(result.rebateReversed, true);

  // Stock is exactly the post-order figure plus the cancelled quantities.
  assert.strictEqual(db._data.inventory.Orange.stock, 21);
  assert.strictEqual(db._data.inventory.Grape.stock, 9);
  assert.strictEqual(db._data.inventory.Cherry.stock, 8);
  assert.strictEqual(db._data.inventory.Watermelon.stock, 10);
  // Flavours that were not in the order are untouched.
  assert.strictEqual(db._data.inventory['Blue Raspberry'].stock, 11);
  assert.strictEqual(db._data.inventory['White Mystery'].stock, 6);

  // The bundle's maxSold slot is available again.
  assert.strictEqual(db._data.bundles.taster.soldCount, 0);

  // The rebate credit that was paid out on this order is taken back.
  assert.strictEqual(db._data.students.Aisyah['Sec 2 Amanah'].credit, 4);
  assert.strictEqual(db._data.orders.order1.rebateReversed, true);
});

test('the restock is idempotent: cancelling twice does not double the stock', async () => {
  const db = makeFakeDb(seedAfterOrder());
  const order = db._data.orders.order1;

  await OrderUtils.restockOrder('order1', order, db);
  const afterFirst = JSON.parse(JSON.stringify(db._data));

  // A second admin approving the same cancellation re-reads the order, which now
  // carries stockRestored: true.
  const second = await OrderUtils.restockOrder('order1', db._data.orders.order1, db);

  assert.strictEqual(second.restored, false);
  assert.strictEqual(second.reason, 'already-restored');
  assert.deepStrictEqual(db._data, afterFirst, 'nothing may change on a repeat cancellation');
});

test('a stale in-memory copy of the order cannot restock a second time either', async () => {
  const db = makeFakeDb(seedAfterOrder());
  const staleOrder = JSON.parse(JSON.stringify(db._data.orders.order1));

  await OrderUtils.restockOrder('order1', staleOrder, db);
  const afterFirst = JSON.parse(JSON.stringify(db._data));

  // Same stale object (stockRestored still absent) but the database already
  // claimed the flag - the claim transaction must refuse the second attempt.
  const second = await OrderUtils.restockOrder('order1', staleOrder, db);

  assert.strictEqual(second.restored, false);
  assert.strictEqual(second.reason, 'claim-lost');
  assert.deepStrictEqual(db._data, afterFirst);
});

test('the rebate claw-back never pushes a student balance below zero', async () => {
  const seed = seedAfterOrder();
  seed.students.Aisyah['Sec 2 Amanah'].credit = 0.4; // already spent most of it
  const db = makeFakeDb(seed);

  await OrderUtils.restockOrder('order1', db._data.orders.order1, db);

  assert.strictEqual(db._data.students.Aisyah['Sec 2 Amanah'].credit, 0);
});

test('an order with no rebate and no bundles still restocks cleanly', async () => {
  const db = makeFakeDb({
    inventory: { Cherry: { price: 1.25, stock: 3 } },
    orders: {
      simple: {
        status: 'pending',
        items: [{ flavor: 'Cherry', qty: 2, price: 1.25 }]
      }
    }
  });

  const result = await OrderUtils.restockOrder('simple', db._data.orders.simple, db);

  assert.strictEqual(result.restored, true);
  assert.strictEqual(result.units, 2);
  assert.strictEqual(result.rebateReversed, false);
  assert.strictEqual(db._data.inventory.Cherry.stock, 5);
});

test('a cancelled order is excluded from revenue but its stock is back on the shelf', async () => {
  const db = makeFakeDb(seedAfterOrder());
  await OrderUtils.restockOrder('order1', db._data.orders.order1, db);

  // What admin.html does after restocking.
  db._data.orders.order1.status = 'cancelled';
  const revenue = Object.values(db._data.orders)
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + (Number(o.total) || 0), 0);

  assert.strictEqual(revenue, 0);
  assert.strictEqual(db._data.inventory.Orange.stock, 21);
});

group('Wiring: pages compile and load the new logic');

const PAGES = ['index.html', 'admin.html', 'ref.html'];

function readPage(name) {
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
}

/** Pull out every inline <script> body (skipping the ones with a src). */
function inlineScripts(html) {
  const bodies = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    bodies.push(match[2]);
  }
  return bodies;
}

PAGES.forEach((page) => {
  test(`${page} has syntactically valid inline JavaScript`, () => {
    const scripts = inlineScripts(readPage(page));
    assert.ok(scripts.length > 0, 'expected at least one inline script');
    scripts.forEach((code, i) => {
      // Compiling (not running) catches syntax errors introduced by the edits.
      new vm.Script(code, { filename: `${page}#inline-script-${i + 1}` });
    });
  });
});

test('the storefront loads the strategy engine and uses it for display', () => {
  const html = readPage('index.html');
  assert.ok(/<script src="pricing-strategies\.js"><\/script>/.test(html), 'module not loaded');
  assert.ok(/anchorPrice\(/.test(html), 'anchoring not wired');
  assert.ok(/scarcityMessage\(/.test(html), 'scarcity messaging not wired');
  assert.ok(/socialProofMessage\(/.test(html), 'social proof not wired');
  assert.ok(/volumeDiscount\(/.test(html), 'volume ladder not wired');
  assert.ok(/rebateForSpend\(/.test(html), 'rebate not wired');
  assert.ok(/settings\/marketing/.test(html), 'marketing settings not read from the database');
});

test('the storefront records the marketing fields on the order', () => {
  const html = readPage('index.html');
  assert.ok(/volumeDiscount:\s*volume\.amount/.test(html), 'order.volumeDiscount missing');
  assert.ok(/rebateAmount:\s*rebate\.amount/.test(html), 'order.rebateAmount missing');
  assert.ok(/rebateAwarded/.test(html), 'rebate is never marked as awarded');
});

test('the admin loads both modules and restocks on cancellation', () => {
  const html = readPage('admin.html');
  assert.ok(/<script src="order-utils\.js"><\/script>/.test(html), 'order-utils not loaded');
  assert.ok(/<script src="pricing-strategies\.js"><\/script>/.test(html), 'strategy engine not loaded');
  assert.ok(/restockCancelledOrder\(orderId, order\)/.test(html), 'cancel path never calls the restock');
  assert.ok(/OrderUtils\.restockOrder\(/.test(html), 'restock does not use the shared, tested orchestration');

  // The idempotency guard and rebate claw-back live in the shared module now, so
  // check they are there rather than duplicated (and drifting) in the page.
  const utils = fs.readFileSync(path.join(__dirname, '..', 'order-utils.js'), 'utf8');
  assert.ok(/stockRestored/.test(utils), 'restock is not guarded against double-crediting');
  assert.ok(/current === true \? undefined : true/.test(utils), 'the claim transaction is missing');
  assert.ok(/collectRebateReversal/.test(utils), 'rebate credit is never clawed back');
});

test('the admin exposes the marketing settings tab', () => {
  const html = readPage('admin.html');
  assert.ok(/data-tab="marketing"/.test(html), 'marketing tab button missing');
  assert.ok(/id="marketingSection"/.test(html), 'marketing section missing');
  assert.ok(/function saveMarketingSettings\(/.test(html), 'settings cannot be saved');
  assert.ok(/PRINCIPLES/.test(html), 'strategy playbook not rendered');
  assert.ok(/0\.61/.test(html), 'the $0.61 Airheads reference is not surfaced');
});

test('every admin tab button resolves to a section that exists', () => {
  // Regression guard for the empty Teams tab: the button carried
  // data-tab="admin-users" while the section was id="adminUsersSection", so the
  // click handler's getElementById("<data-tab>Section") returned null and threw,
  // leaving the tab rendering nothing. Checking every tab (not just one) means a
  // mismatch introduced by any future tab fails here instead of in the browser.
  const html = readPage('admin.html');
  const tabs = [...html.matchAll(/data-tab="([a-zA-Z-]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 9, `expected the full tab set, found ${tabs.length}`);
  assert.ok(tabs.includes('marketing'), 'marketing tab disappeared');

  tabs.forEach((tab) => {
    const expectedId = `${tab}Section`;
    assert.ok(
      html.includes(`id="${expectedId}"`),
      `tab "${tab}" has no matching #${expectedId} section - clicking it would render nothing`
    );
  });
});

test('the admin subscribes to each Firebase path exactly once', () => {
  // The Team tab's data used to be loaded twice: a pre-login listener filled
  // dbTeamMembers for the login lookup, and loadTeamData() opened a second
  // listener on the same path purely to render. Both fired on every team change.
  const html = readPage('admin.html');
  const refs = [...html.matchAll(/db\.ref\('([a-z_]+)'\)\.on\('value'/g)].map((m) => m[1]);
  const duplicates = refs.filter((p, i) => refs.indexOf(p) !== i);
  assert.deepStrictEqual(duplicates, [], `duplicate listeners on: ${duplicates.join(', ')}`);
  assert.ok(refs.includes('admin_team'), 'admin_team is no longer watched (login lookup would break)');
});

test('the reference price used across the codebase is the $0.61 Airheads bar', () => {
  ['index.html', 'admin.html'].forEach((page) => {
    assert.ok(/0\.61/.test(readPage(page)), `${page} does not reference the $0.61 buy price`);
  });
});

test('the dashboard counts volume discounts and rebates as savings', () => {
  const html = readPage('ref.html');
  assert.ok(/o\.volumeDiscount/.test(html), 'volume discount not counted');
  assert.ok(/o\.rebateAmount/.test(html), 'rebate not counted');
});

// ===========================================================================

runAll();
