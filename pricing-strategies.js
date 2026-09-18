/**
 * pricing-strategies.js
 * ---------------------------------------------------------------------------
 * A small, dependency-free library of psychological pricing and marketing
 * strategies for the Airheads storefront.
 *
 * Every number in here is calibrated against one concrete reference product:
 *
 *     Airheads candy bar (any flavour), buy price ~= $0.61 per bar
 *
 * From that single cost the library derives:
 *
 *   - charm / left-digit prices      (charmPrice)
 *   - a margin-safe price ladder     (priceLadder)
 *   - anchored "was / now" framing   (anchorPrice)
 *   - a volume-discount ladder       (volumeDiscount)
 *   - a decoy option set             (decoyLadder)
 *   - a tiered rebate / cashback     (rebateForSpend)
 *   - scarcity + social-proof copy   (scarcityMessage / socialProofMessage)
 *
 * It is deliberately pure: no DOM, no Firebase, no clock. The browser pages
 * consume it as `window.PricingStrategies`, and the Node test suite requires it
 * directly, so the shop maths and the tested maths cannot drift apart.
 *
 * Loaded as a plain <script> before the page scripts.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.PricingStrategies = api;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Reference product
  // ---------------------------------------------------------------------------

  /** The concrete example every strategy below is calibrated on. */
  var REFERENCE_PRODUCT = {
    name: 'Airheads (any flavour)',
    buyPrice: 0.61
  };

  /**
   * Defaults. `targetMarkup: 1.0` means "aim for a 100% markup", i.e. a target
   * price of 0.61 * 2 = $1.22 for one bar, which charm pricing then snaps to a
   * shelf-friendly $1.25.
   */
  var DEFAULT_CONFIG = {
    cost: REFERENCE_PRODUCT.buyPrice,
    targetMarkup: 1.0,
    // Prices ending here read as "one-something" and are the classic retail
    // charm endings for sub-$5 items.
    charmEndings: [0.99, 0.95, 0.75, 0.49, 0.25],
    // How far above the real price the struck-through anchor sits.
    anchorUplift: 0.35,
    volumeTiers: [
      { qty: 3, percent: 5 },
      { qty: 5, percent: 10 },
      { qty: 10, percent: 15 }
    ],
    rebateTiers: [
      { minSpend: 3, rate: 5 },
      { minSpend: 5, rate: 8 },
      { minSpend: 8, rate: 12 }
    ],
    // Hard ceiling on a single rebate, so one big order can't hand back the
    // whole margin.
    rebateCap: 1.5,
    // Below this many units left, show an urgency badge.
    scarcityThreshold: 6,
    // Only show the "sold today" badge once it is actually impressive.
    socialProofFloor: 5,
    decoy: {
      midQty: 3,
      highQty: 6,
      highDiscountPercent: 15
    }
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function positive(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /** Merge caller overrides over the defaults (top-level keys only). */
  function mergeConfig(overrides) {
    var cfg = clone(DEFAULT_CONFIG);
    if (overrides && typeof overrides === 'object') {
      Object.keys(overrides).forEach(function (key) {
        if (overrides[key] === undefined || overrides[key] === null) return;
        cfg[key] = overrides[key];
      });
    }
    return cfg;
  }

  function normalizeVolumeTiers(tiers) {
    var list = Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_CONFIG.volumeTiers;
    return list
      .map(function (t) {
        return { qty: Math.max(1, Math.floor(Number(t && t.qty) || 0)), percent: Math.max(0, Number(t && t.percent) || 0) };
      })
      .filter(function (t) { return t.qty >= 1 && t.percent > 0; })
      .sort(function (a, b) { return a.qty - b.qty; });
  }

  function normalizeRebateTiers(tiers) {
    var list = Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_CONFIG.rebateTiers;
    return list
      .map(function (t) {
        return { minSpend: Math.max(0, Number(t && t.minSpend) || 0), rate: Math.max(0, Number(t && t.rate) || 0) };
      })
      .filter(function (t) { return t.rate > 0; })
      .sort(function (a, b) { return a.minSpend - b.minSpend; });
  }

  // ---------------------------------------------------------------------------
  // 1. Charm / left-digit pricing
  // ---------------------------------------------------------------------------

  /**
   * Snap a target price to a psychologically friendlier number.
   *
   * mode 'up'   (default) -> smallest charm price >= target. Protects margin,
   *                          used for list prices.
   * mode 'down'           -> largest charm price <= target. Used for "deal"
   *                          framing such as multi-buy totals.
   *
   * Example: charmPrice(1.22) === 1.25
   *
   * @param {number} target
   * @param {number[]} [endings]
   * @param {'up'|'down'} [mode]
   */
  function charmPrice(target, endings, mode) {
    var t = Number(target);
    if (!Number.isFinite(t) || t <= 0) return 0;

    var ends = (Array.isArray(endings) && endings.length ? endings : DEFAULT_CONFIG.charmEndings)
      .map(function (e) { return Number(e); })
      .filter(function (e) { return Number.isFinite(e) && e >= 0 && e < 1; })
      .sort(function (a, b) { return a - b; });
    if (!ends.length) return round2(t);

    var wantUp = mode !== 'down';
    var best = null;
    var maxWhole = Math.ceil(t) + 1;

    for (var whole = 0; whole <= maxWhole; whole++) {
      for (var i = 0; i < ends.length; i++) {
        var candidate = round2(whole + ends[i]);
        if (wantUp ? candidate >= t - 1e-9 : candidate <= t + 1e-9) {
          if (best === null) {
            best = candidate;
          } else if (wantUp ? candidate < best : candidate > best) {
            best = candidate;
          }
        }
      }
    }

    return best === null ? round2(t) : best;
  }

  /** Margin arithmetic for a single unit. */
  function margin(price, cost) {
    var p = Math.max(0, Number(price) || 0);
    var c = Math.max(0, Number(cost) || 0);
    var profit = round2(p - c);
    return {
      price: round2(p),
      cost: round2(c),
      profit: profit,
      marginPercent: p > 0 ? round2((profit / p) * 100) : 0,
      markupPercent: c > 0 ? round2((profit / c) * 100) : 0
    };
  }

  /**
   * A three-rung price ladder built from the buy price, each rung snapped to a
   * charm ending. The middle rung is the one to actually charge.
   *
   * With cost 0.61:  $0.99 / $1.25 / $1.75
   */
  function priceLadder(cost, overrides) {
    var cfg = mergeConfig(overrides);
    var c = positive(cost, cfg.cost);
    // Multipliers are applied to the markup, not the price. 0.6 keeps the entry
    // rung below the regular rung *after* charm rounding (0.61 -> $0.95-$0.99),
    // which is what stops the three rungs from collapsing onto each other.
    var rungs = [
      { key: 'entry', label: 'Entry price', multiplier: 0.6, note: 'Loss-leader / bulk giveaway' },
      { key: 'regular', label: 'Regular price', multiplier: 1.0, note: 'Recommended shelf price' },
      { key: 'premium', label: 'Premium price', multiplier: 1.6, note: 'Single-bar impulse buy' }
    ];

    return rungs.map(function (rung) {
      var target = c * (1 + cfg.targetMarkup * rung.multiplier);
      var price = charmPrice(target, cfg.charmEndings, 'up');
      var m = margin(price, c);
      return {
        key: rung.key,
        label: rung.label,
        note: rung.note,
        targetPrice: round2(target),
        price: price,
        profit: m.profit,
        marginPercent: m.marginPercent,
        markupPercent: m.markupPercent
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Anchoring
  // ---------------------------------------------------------------------------

  /**
   * Produce the struck-through "was" price for a real price, plus the saving.
   * The anchor is itself charm-priced so the two numbers look like a real pair.
   *
   * Example: anchorPrice(1.25) -> was $1.75, save $0.50 (29% off)
   */
  function anchorPrice(price, overrides) {
    var cfg = mergeConfig(overrides);
    var p = Math.max(0, Number(price) || 0);
    if (p <= 0) return { price: 0, anchor: 0, savings: 0, savingsPercent: 0 };

    var anchor = charmPrice(p * (1 + cfg.anchorUplift), cfg.charmEndings, 'up');
    // Guard the edge case where charm rounding collapses the anchor onto the
    // price itself - a "was $1.25 / now $1.25" banner is worse than none.
    if (anchor <= p) anchor = charmPrice(p + 0.25, cfg.charmEndings, 'up');

    var savings = round2(anchor - p);
    return {
      price: round2(p),
      anchor: anchor,
      savings: savings,
      savingsPercent: anchor > 0 ? round2((savings / anchor) * 100) : 0
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Volume discount ladder
  // ---------------------------------------------------------------------------

  /**
   * Quantity-based discount that is applied to the *flavours-only* subtotal.
   * Bundles are already discounted, so they never stack into this.
   *
   * Returns the tier that applies, the money off, and how many more bars the
   * shopper needs for the next tier (the goal-gradient nudge shown in the cart).
   *
   * @param {number} units total billable bars in the cart
   * @param {number} baseSubtotal the discountable (non-bundle) subtotal
   */
  function volumeDiscount(units, baseSubtotal, overrides) {
    var cfg = mergeConfig(overrides);
    var tiers = normalizeVolumeTiers(cfg.volumeTiers);
    var u = Math.max(0, Math.floor(Number(units) || 0));
    var base = Math.max(0, Number(baseSubtotal) || 0);

    var applied = null;
    var next = null;
    tiers.forEach(function (tier) {
      if (u >= tier.qty) applied = tier;
      else if (!next) next = tier;
    });

    var amount = applied ? round2((base * applied.percent) / 100) : 0;
    return {
      units: u,
      tiers: tiers,
      appliedTier: applied,
      percent: applied ? applied.percent : 0,
      amount: amount,
      nextTier: next,
      unitsToNextTier: next ? Math.max(0, next.qty - u) : 0
    };
  }

  /** One-line nudge for the cart sheet, or null when nothing is left to unlock. */
  function volumeNudge(volume) {
    if (!volume) return null;
    if (volume.appliedTier) {
      if (!volume.nextTier) {
        return 'Best volume price unlocked - ' + volume.percent + '% off';
      }
      return volume.percent + '% off applied. Add ' + volume.unitsToNextTier +
        ' more for ' + volume.nextTier.percent + '% off';
    }
    if (volume.nextTier) {
      return 'Add ' + volume.unitsToNextTier + ' more to unlock ' + volume.nextTier.percent + '% off';
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 4. Decoy option set
  // ---------------------------------------------------------------------------

  /**
   * Three options where the middle one is deliberately poor value per bar, so
   * the large option looks like the obvious buy.
   *
   * With a $1.25 bar:  1 bar $1.25 · 3 bars $3.75 · 6 bars $6.25 ($1.04/bar)
   * The 3-bar option has no per-bar saving at all - that is the decoy.
   */
  function decoyLadder(unitPrice, overrides) {
    var cfg = mergeConfig(overrides);
    var decoyCfg = cfg.decoy || DEFAULT_CONFIG.decoy;
    var unit = positive(unitPrice, 0);
    if (unit <= 0) return { options: [], decoyKey: 'mid', recommendedKey: 'high' };

    var midQty = Math.max(2, Math.floor(Number(decoyCfg.midQty) || 3));
    var highQty = Math.max(midQty + 1, Math.floor(Number(decoyCfg.highQty) || 6));
    var highDiscount = Math.max(0, Math.min(90, Number(decoyCfg.highDiscountPercent) || 0));

    var options = [
      { key: 'single', label: '1 bar', qty: 1, price: round2(unit), decoy: false, recommended: false },
      { key: 'mid', label: midQty + ' bars', qty: midQty, price: round2(unit * midQty), decoy: true, recommended: false },
      {
        key: 'high',
        label: highQty + ' bars',
        qty: highQty,
        // Round the deal *down* to a charm ending so it reads as a bargain.
        price: charmPrice(unit * highQty * (1 - highDiscount / 100), cfg.charmEndings, 'down'),
        decoy: false,
        recommended: true
      }
    ];

    options.forEach(function (option) {
      option.unitPrice = round2(option.price / option.qty);
      option.savingsVsSingle = round2(unit * option.qty - option.price);
    });

    return { options: options, decoyKey: 'mid', recommendedKey: 'high' };
  }

  // ---------------------------------------------------------------------------
  // 5. Tiered rebate / cashback
  // ---------------------------------------------------------------------------

  /**
   * Spend-more-earn-more rebate, returned as store credit rather than a
   * discount. Credit is deliberately used instead of a price cut: it feels like
   * a reward (so the perceived value of the order goes up, not the price down)
   * and it pulls the buyer back for a second purchase.
   *
   * With the defaults: $3 -> 5%, $5 -> 8%, $8 -> 12% (capped at $1.50).
   */
  function rebateForSpend(spend, overrides) {
    var cfg = mergeConfig(overrides);
    var tiers = normalizeRebateTiers(cfg.rebateTiers);
    var s = Math.max(0, Number(spend) || 0);
    var cap = Math.max(0, Number(cfg.rebateCap) || 0);

    var applied = null;
    var next = null;
    tiers.forEach(function (tier) {
      if (s >= tier.minSpend) applied = tier;
      else if (!next) next = tier;
    });

    var raw = applied ? (s * applied.rate) / 100 : 0;
    var amount = round2(Math.min(raw, cap));

    return {
      spend: round2(s),
      tiers: tiers,
      rate: applied ? applied.rate : 0,
      amount: amount,
      capped: raw > cap + 1e-9,
      nextTier: next,
      spendToNextTier: next ? round2(Math.max(0, next.minSpend - s)) : 0
    };
  }

  /** One-line nudge for the cart sheet, or null when nothing is left to unlock. */
  function rebateNudge(rebate) {
    if (!rebate) return null;
    if (rebate.amount > 0) {
      if (!rebate.nextTier) {
        return 'You earn $' + rebate.amount.toFixed(2) + ' store credit on this order';
      }
      return 'You earn $' + rebate.amount.toFixed(2) + ' back. Spend $' +
        rebate.spendToNextTier.toFixed(2) + ' more for ' + rebate.nextTier.rate + '% back';
    }
    if (rebate.nextTier) {
      return 'Spend $' + rebate.spendToNextTier.toFixed(2) + ' to earn ' + rebate.nextTier.rate + '% back as store credit';
    }
    return null;
  }

  /**
   * Prove the rebate is affordable: what the seller actually keeps once the
   * cashback is handed over. Used by the admin preview so nobody sets a rebate
   * that eats the margin.
   */
  function effectiveMargin(price, cost, rebatePercent) {
    var p = Math.max(0, Number(price) || 0);
    var c = Math.max(0, Number(cost) || 0);
    var rebate = p * (Math.max(0, Number(rebatePercent) || 0) / 100);
    var net = round2(p - rebate);
    var profit = round2(net - c);
    return {
      price: round2(p),
      rebate: round2(rebate),
      netRevenue: net,
      profit: profit,
      marginPercent: net > 0 ? round2((profit / net) * 100) : 0
    };
  }

  // ---------------------------------------------------------------------------
  // 6. Scarcity and social proof
  // ---------------------------------------------------------------------------

  /** Urgency badge copy driven by remaining stock. */
  function scarcityMessage(stock, overrides) {
    var cfg = mergeConfig(overrides);
    var s = Math.max(0, Math.floor(Number(stock) || 0));
    var threshold = Math.max(1, Math.floor(Number(cfg.scarcityThreshold) || 1));

    if (s <= 0) return { level: 'out', text: 'Sold out' };
    if (s <= 2) return { level: 'critical', text: 'Only ' + s + ' left - last chance' };
    if (s <= threshold) return { level: 'low', text: 'Only ' + s + ' left' };
    return { level: 'ok', text: s + ' in stock' };
  }

  /** Bandwagon copy from today's sales, or null when the number is too small. */
  function socialProofMessage(unitsSoldToday, overrides) {
    var cfg = mergeConfig(overrides);
    var units = Math.max(0, Math.floor(Number(unitsSoldToday) || 0));
    var floor = Math.max(1, Math.floor(Number(cfg.socialProofFloor) || 1));
    if (units < floor) return null;
    return { units: units, text: units + ' sold today' };
  }

  // ---------------------------------------------------------------------------
  // 7. The strategy playbook
  // ---------------------------------------------------------------------------

  /**
   * The written half of the feature: what each tactic is, why it works, and how
   * it is wired into this shop. Rendered in the admin Marketing tab.
   */
  var PRINCIPLES = [
    {
      key: 'charm',
      name: 'Charm / left-digit pricing',
      tactic: 'Never show a round number. Snap every price to a .25 / .49 / .75 / .95 / .99 ending.',
      why: 'Shoppers read left to right and latch onto the leading digit, so $1.25 registers as "one-something" while $1.30 feels closer to two.',
      example: '$1.22 target becomes $1.25 (margin-protected, never rounded down).'
    },
    {
      key: 'anchor',
      name: 'Price anchoring',
      tactic: 'Show a struck-through "was" price beside the live price on every card.',
      why: 'A reference point reframes the real price as a gain instead of a cost. The anchor is charm-priced too, so the pair looks like a genuine before/after.',
      example: 'was $1.75, now $1.25 - save $0.50 (29% off).'
    },
    {
      key: 'decoy',
      name: 'Decoy effect',
      tactic: 'Offer 1 / 3 / 6 bars where the 3-bar option carries no per-bar saving.',
      why: 'A deliberately mediocre middle option makes the large option look like the smart choice, pushing the average basket up rather than just the price.',
      example: '3 bars at $1.25 each, or 6 bars for $6.25 ($1.04 a bar).'
    },
    {
      key: 'volume',
      name: 'Volume discount ladder',
      tactic: 'Unlock 5% at 3 bars, 10% at 5, 15% at 10, and show how far the next tier is.',
      why: 'Goal-gradient plus loss aversion: once a shopper is one bar from the next tier, adding a bar feels like avoiding a loss rather than spending more.',
      example: '"Add 2 more to unlock 10% off" - the cheapest unit of sales the shop has.'
    },
    {
      key: 'rebate',
      name: 'Tiered rebate / cashback',
      tactic: 'Spend $3 to earn 5% back, $5 for 8%, $8 for 12%, paid as store credit and capped at $1.50.',
      why: 'A rebate reads as a reward, not a price cut, so perceived value rises while the price stays put. Store credit also guarantees the next visit.',
      example: 'An $8.50 order earns $1.02 credit; at a $1.25 price and $0.61 cost the seller still keeps a healthy margin.'
    },
    {
      key: 'scarcity',
      name: 'Scarcity and urgency',
      tactic: 'Surface "Only N left" once stock drops to the threshold.',
      why: 'Limited availability raises perceived value and shortens decision time, which matters for a lunch-break impulse buy.',
      example: '"Only 4 left" instead of a neutral "4 in stock".'
    },
    {
      key: 'socialProof',
      name: 'Social proof',
      tactic: 'Show how many bars sold today, once the number is worth showing.',
      why: 'People copy the behaviour of people like them. A visible crowd removes the risk of trying something new.',
      example: '"37 sold today".'
    },
    {
      key: 'reciprocity',
      name: 'Reciprocity (free bar)',
      tactic: 'Give one free bar after a qualifying spend, redeemed through the spin wheel.',
      why: 'An unexpected gift creates a felt obligation to return the favour - here, a follow-up order.',
      example: 'Spend $5+, win a free bar, come back to redeem it.'
    },
    {
      key: 'commitment',
      name: 'Commitment and consistency',
      tactic: 'Track repeat orders on the dashboard and nudge the next tier.',
      why: 'Once someone has identified as a regular customer, they keep behaving like one. Progress that is visible is progress that gets finished.',
      example: 'Repeat-buyer streaks and rebate tiers shown on the student dashboard.'
    },
    {
      key: 'bundling',
      name: 'Bundling and loss aversion',
      tactic: 'Sell mixed-flavour bundles at a set price, with a visible saving versus buying separately.',
      why: 'Framing the saving as something the shopper would otherwise lose is more motivating than framing it as a gain.',
      example: 'Save $0.75 versus buying the four bars separately.'
    }
  ];

  // ---------------------------------------------------------------------------
  // 8. Orchestrator
  // ---------------------------------------------------------------------------

  /**
   * Everything the admin panel needs for one reference product, in one call.
   *
   * @param {number} [cost] buy price per bar; defaults to the Airheads reference
   * @param {object} [overrides]
   */
  function recommendStrategies(cost, overrides) {
    var cfg = mergeConfig(overrides);
    var c = positive(cost, REFERENCE_PRODUCT.buyPrice);

    var ladder = priceLadder(c, cfg);
    var regular = ladder.filter(function (r) { return r.key === 'regular'; })[0] || ladder[0];
    var bestRebateRate = normalizeRebateTiers(cfg.rebateTiers).reduce(function (max, t) {
      return Math.max(max, t.rate);
    }, 0);

    return {
      reference: { name: REFERENCE_PRODUCT.name, buyPrice: round2(c) },
      charmPricing: {
        enabled: true,
        endings: cfg.charmEndings,
        targetPrice: regular.targetPrice,
        shelfPrice: regular.price
      },
      priceLadder: ladder,
      anchoring: anchorPrice(regular.price, cfg),
      volume: volumeDiscount(5, regular.price * 5, cfg),
      rebate: rebateForSpend(5, cfg),
      rebateCap: cfg.rebateCap,
      decoy: decoyLadder(regular.price, cfg),
      affordability: {
        atShelfPrice: effectiveMargin(regular.price, c, 0),
        atBestRebateTier: effectiveMargin(regular.price, c, bestRebateRate)
      },
      messaging: {
        scarcity: scarcityMessage(4, cfg),
        socialProof: socialProofMessage(12, cfg)
      },
      principles: clone(PRINCIPLES)
    };
  }

  return {
    REFERENCE_PRODUCT: REFERENCE_PRODUCT,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    PRINCIPLES: PRINCIPLES,
    round2: round2,
    mergeConfig: mergeConfig,
    charmPrice: charmPrice,
    margin: margin,
    priceLadder: priceLadder,
    anchorPrice: anchorPrice,
    volumeDiscount: volumeDiscount,
    volumeNudge: volumeNudge,
    decoyLadder: decoyLadder,
    rebateForSpend: rebateForSpend,
    rebateNudge: rebateNudge,
    effectiveMargin: effectiveMargin,
    scarcityMessage: scarcityMessage,
    socialProofMessage: socialProofMessage,
    recommendStrategies: recommendStrategies
  };
});
