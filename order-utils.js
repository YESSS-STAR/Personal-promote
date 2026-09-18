/**
 * order-utils.js
 * ---------------------------------------------------------------------------
 * Pure helpers that describe how an order maps back onto inventory.
 *
 * They live in their own file (instead of inline in admin.html) so the
 * cancellation/restock maths can be unit-tested with plain Node, with no
 * Firebase connection and no DOM.
 *
 * Loaded as a plain <script> in the browser (exposes `window.OrderUtils`) and
 * required directly by the test suite.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.OrderUtils = api;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  /** Coerce anything into a non-negative integer, defaulting to 0. */
  function toQty(value) {
    var n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Money is stored in dollars, and float subtraction drifts: 5.02 - 1.02 is
   * 3.9999999999999996 in IEEE 754, which would leave a student's credit a
   * fraction of a cent short and print as "$4.00" while comparing as less.
   * Every balance write goes through this.
   */
  function roundMoney(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  /**
   * Work out how many units of each flavour a cancelled order should hand back.
   *
   * Three shapes of line item exist in the database:
   *   1. { flavor, qty, price }            - a direct flavour pick
   *   2. { flavor, qty, price:0, free:true } - a free reward bar (still taken
   *                                            out of real stock at checkout)
   *   3. { bundle, name, qty, components:{flavor:qty}, price } - a bundle, which
   *                                            reserved `components` worth of
   *                                            stock per bundle sold
   *
   * @param {Array} items order.items as stored in Firebase
   * @returns {Object} map of flavour -> units to add back to inventory
   */
  function collectStockRestoration(items) {
    var out = {};
    if (!Array.isArray(items)) return out;

    items.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var qty = toQty(item.qty);
      if (qty <= 0) return;

      // Bundle line: restock every component flavour, multiplied by the number
      // of bundles bought.
      if (item.bundle || item.components) {
        var components = item.components || {};
        Object.keys(components).forEach(function (flavor) {
          var perBundle = toQty(components[flavor]);
          if (perBundle <= 0) return;
          out[flavor] = (out[flavor] || 0) + perBundle * qty;
        });
        return;
      }

      // Plain flavour line (paid or free reward unit).
      if (typeof item.flavor === 'string' && item.flavor) {
        out[item.flavor] = (out[item.flavor] || 0) + qty;
      }
    });

    return out;
  }

  /**
   * Bundle sold-counts are stock in their own right: checkout claims a "sold"
   * slot per bundle so `maxSold` limits are respected, so a cancellation has to
   * hand those slots back too.
   *
   * @param {Array} items
   * @returns {Object} map of bundleId -> count to release
   */
  function collectBundleRestoration(items) {
    var out = {};
    if (!Array.isArray(items)) return out;

    items.forEach(function (item) {
      if (!item || typeof item !== 'object' || !item.bundle) return;
      var qty = toQty(item.qty);
      if (qty <= 0) return;
      out[item.bundle] = (out[item.bundle] || 0) + qty;
    });

    return out;
  }

  /**
   * Pure application of a restoration map onto an inventory snapshot. Used by
   * the tests to prove that a cancel lands stock exactly back where it started;
   * the browser code uses Firebase transactions instead (see admin.html).
   *
   * @param {Object} inventory  { flavor: { price, stock } }
   * @param {Object} restoration map of flavor -> units
   * @returns {Object} a new inventory object (input is not mutated)
   */
  function applyRestoration(inventory, restoration) {
    var next = {};
    var inv = inventory || {};
    Object.keys(inv).forEach(function (flavor) {
      var entry = inv[flavor] || {};
      next[flavor] = {
        price: Number(entry.price) || 0,
        stock: Number(entry.stock) || 0
      };
    });

    var rest = restoration || {};
    Object.keys(rest).forEach(function (flavor) {
      var units = toQty(rest[flavor]);
      if (units <= 0) return;
      if (!next[flavor]) next[flavor] = { price: 0, stock: 0 };
      next[flavor].stock += units;
    });

    return next;
  }

  /** Total units across an order, used for reporting/testing convenience. */
  function totalRestoredUnits(restoration) {
    return Object.keys(restoration || {}).reduce(function (sum, flavor) {
      return sum + toQty(restoration[flavor]);
    }, 0);
  }

  /**
   * An order must only ever be restocked once. The flag is written before the
   * stock transactions run (claim-then-act), so two admins approving the same
   * cancellation cannot double the stock back.
   */
  function isRestored(order) {
    return !!(order && order.stockRestored === true);
  }

  /**
   * Rebate store credit is handed out when an order is placed. If that order is
   * later cancelled the credit has to be clawed back, otherwise cancelling would
   * be a way to mint free credit.
   *
   * @returns {?{amount:number, path:string}} null when there is nothing to reverse
   */
  function collectRebateReversal(order) {
    if (!order || order.rebateAwarded !== true || order.rebateReversed === true) return null;

    var amount = Math.max(0, Number(order.rebateAmount) || 0);
    var to = order.rebateAwardedTo;
    if (amount <= 0) return null;
    if (!to || typeof to.name !== 'string' || typeof to.class !== 'string' || !to.name || !to.class) return null;

    return {
      amount: Math.round(amount * 100) / 100,
      path: 'students/' + to.name + '/' + to.class + '/credit'
    };
  }

  /**
   * The whole restock, driven through a Firebase-shaped adapter (`db` in the
   * page, an in-memory fake in the tests) so the exact code that runs in
   * production is the code under test.
   *
   * Steps, in order:
   *   1. Claim the `stockRestored` flag (idempotency guard, claim-then-act).
   *   2. Add each flavour's units back to inventory.
   *   3. Release the bundle sold-count slots the order claimed.
   *   4. Claw back any rebate store credit the order was paid.
   *
   * @param {string} orderId
   * @param {object} order the order as stored in the database
   * @param {object} db    Firebase-compatible adapter: ref(path).{once,set,transaction}
   * @returns {Promise<{restored:boolean, reason?:string, units?:number, flavors?:object, rebateReversed?:boolean}>}
   */
  async function restockOrder(orderId, order, db) {
    if (isRestored(order)) return { restored: false, reason: 'already-restored' };

    const claim = await db.ref('orders/' + orderId + '/stockRestored')
      .transaction(function (current) { return current === true ? undefined : true; });
    if (!claim.committed) return { restored: false, reason: 'claim-lost' };

    try {
      const restoration = collectStockRestoration(order.items);
      const flavors = Object.keys(restoration);
      for (let i = 0; i < flavors.length; i++) {
        const flavor = flavors[i];
        const units = restoration[flavor];
        await db.ref('inventory/' + flavor + '/stock')
          .transaction(function (current) { return (Number(current) || 0) + units; });
      }

      const bundleRelease = collectBundleRestoration(order.items);
      const bundleIds = Object.keys(bundleRelease);
      for (let i = 0; i < bundleIds.length; i++) {
        const bundleId = bundleIds[i];
        const sold = bundleRelease[bundleId];
        await db.ref('bundles/' + bundleId).transaction(function (current) {
          if (!current) return current;
          current.soldCount = Math.max(0, (current.soldCount || 0) - sold);
          return current;
        });
      }

      const rebate = collectRebateReversal(order);
      if (rebate) {
        await db.ref(rebate.path).transaction(function (current) {
          return Math.max(0, roundMoney((Number(current) || 0) - rebate.amount));
        });
        await db.ref('orders/' + orderId + '/rebateReversed').set(true);
      }

      return {
        restored: true,
        units: totalRestoredUnits(restoration),
        flavors: restoration,
        rebateReversed: !!rebate
      };
    } catch (err) {
      // Hand the claim back so a retry can still restock.
      await db.ref('orders/' + orderId + '/stockRestored').set(false);
      throw err;
    }
  }

  return {
    toQty: toQty,
    roundMoney: roundMoney,
    collectStockRestoration: collectStockRestoration,
    collectBundleRestoration: collectBundleRestoration,
    applyRestoration: applyRestoration,
    totalRestoredUnits: totalRestoredUnits,
    isRestored: isRestored,
    collectRebateReversal: collectRebateReversal,
    restockOrder: restockOrder
  };
});
