/**
 * streak-utils.js
 * ---------------------------------------------------------------------------
 * Pure helpers for customer retention through weekly order streaks
 * and repeating milestone rewards.
 *
 * Configurable in three modes:
 *   1. 'calendar_grace' (default) - Calendar weeks (Mon-Sun) with 1 grace week.
 *   2. 'strict_calendar'          - Strict calendar weeks; missed week resets streak.
 *   3. 'drop_cycles'              - Admin-defined restock drop cycles.
 *
 * Milestones (5-week repeating loop):
 *   - Step 3 (Week 3, 8, 13...): 1 Free Airheads Bar Token
 *   - Step 5 (Week 5, 10, 15...): $1.50 Store Credit
 *
 * Pure JavaScript: no DOM, no Firebase, works in Node test suite and browser.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.StreakUtils = api;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  var DEFAULT_CONFIG = {
    enabled: true,
    mode: 'calendar_grace', // 'calendar_grace' | 'strict_calendar' | 'drop_cycles'
    minSpend: 2.50,         // Minimum spend ($) to count toward streak
    cycleLength: 5,         // Repeats every 5 weeks
    milestones: [
      { step: 3, type: 'free_bar', qty: 1, label: 'Free Airheads Bar' },
      { step: 5, type: 'credit', amount: 1.50, label: '$1.50 Store Credit' }
    ]
  };

  function mergeConfig(custom) {
    if (!custom || typeof custom !== 'object') return DEFAULT_CONFIG;
    var out = {};
    for (var k in DEFAULT_CONFIG) {
      out[k] = DEFAULT_CONFIG[k];
    }
    for (var ck in custom) {
      if (custom[ck] !== undefined) {
        out[ck] = custom[ck];
      }
    }
    return out;
  }

  /**
   * Helper to normalize a date/timestamp to midnight of the week's Monday (UTC).
   */
  function getStartOfWeek(dateOrTimestamp) {
    var d = new Date(dateOrTimestamp);
    if (isNaN(d.getTime())) return null;
    d.setUTCHours(0, 0, 0, 0);
    var day = d.getUTCDay(); // 0 is Sun, 1 is Mon...
    var diff = (day === 0 ? -6 : 1) - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.getTime();
  }

  /**
   * Number of calendar weeks difference between two dates/timestamps.
   */
  function getWeeksDifference(timeA, timeB) {
    var startA = getStartOfWeek(timeA);
    var startB = getStartOfWeek(timeB);
    if (startA === null || startB === null) return 0;
    var msPerWeek = 7 * 24 * 60 * 60 * 1000;
    return Math.round((startB - startA) / msPerWeek);
  }

  /**
   * Determine milestone information for a given streak number.
   * Cycles every cycleLength (default 5).
   */
  function getMilestoneForStreak(streak, config) {
    var cfg = mergeConfig(config);
    var cycle = cfg.cycleLength || 5;
    var currentStep = ((streak - 1) % cycle) + 1; // 1 to 5

    var milestones = (cfg.milestones || []).slice().sort(function (a, b) {
      return a.step - b.step;
    });

    for (var i = 0; i < milestones.length; i++) {
      if (milestones[i].step >= currentStep) {
        var distance = milestones[i].step - currentStep;
        return {
          targetStreak: streak + distance,
          step: milestones[i].step,
          type: milestones[i].type,
          label: milestones[i].label,
          qty: milestones[i].qty,
          amount: milestones[i].amount,
          distance: distance
        };
      }
    }

    // Next cycle's first milestone
    var first = milestones[0] || { step: 3, type: 'free_bar', label: 'Free Airheads Bar', qty: 1 };
    var distanceToNextCycle = (cycle - currentStep) + first.step;
    return {
      targetStreak: streak + distanceToNextCycle,
      step: first.step,
      type: first.type,
      label: first.label,
      qty: first.qty,
      amount: first.amount,
      distance: distanceToNextCycle
    };
  }

  /**
   * Check if transitioning from prevStreak to newStreak unlocks any milestone rewards.
   * Tolerates both (prevStreak, newStreak) and (currentStreak, previousStreak) argument orders.
   */
  function evaluateMilestoneReward(prevStreak, newStreak, config) {
    var prev = Number(prevStreak) || 0;
    var next = Number(newStreak) || 0;
    if (prev > next) {
      var tmp = prev;
      prev = next;
      next = tmp;
    }
    if (next <= prev) return null;
    var cfg = mergeConfig(config);
    var cycle = cfg.cycleLength || 5;

    // Check each step stepped into
    for (var s = prev + 1; s <= next; s++) {
      var step = ((s - 1) % cycle) + 1;
      var milestones = cfg.milestones || [];
      for (var m = 0; m < milestones.length; m++) {
        if (milestones[m].step === step) {
          return {
            unlocked: true,
            streak: s,
            step: step,
            type: milestones[m].type,
            qty: milestones[m].qty || 1,
            amount: milestones[m].amount || 0,
            label: milestones[m].label
          };
        }
      }
    }
    return null;
  }

  /**
   * Compute current streak state from order history.
   *
   * @param {Array} orders List of orders for student.
   * @param {Object} [options]
   * @param {number|Date} [options.now] Current timestamp (for testing or real clock).
   * @param {Object} [options.config] Custom streak settings.
   */
  function computeStreak(orders, options) {
    var opts = options || {};
    var cfg = mergeConfig(opts.config);
    var now = opts.now !== undefined ? new Date(opts.now).getTime() : Date.now();

    if (!cfg.enabled || !Array.isArray(orders) || orders.length === 0) {
      var initialMilestone = getMilestoneForStreak(1, cfg);
      return {
        currentStreak: 0,
        hasOrderedThisPeriod: false,
        graceActive: false,
        nextMilestone: initialMilestone,
        qualifyingOrdersCount: 0,
        lastOrderWeek: null
      };
    }

    var minSpend = Number(cfg.minSpend) || 2.50;
    var mode = cfg.mode || 'calendar_grace';

    // 1. Filter to valid, non-cancelled orders meeting minimum spend
    var qualifyingOrders = orders.filter(function (o) {
      if (!o || o.status === 'cancelled') return false;
      var spend = Number(o.total);
      if (!Number.isFinite(spend)) {
        spend = Number(o.subtotal) || 0;
      }
      return spend >= minSpend;
    });

    if (qualifyingOrders.length === 0) {
      var emptyMilestone = getMilestoneForStreak(1, cfg);
      return {
        currentStreak: 0,
        hasOrderedThisPeriod: false,
        graceActive: false,
        nextMilestone: emptyMilestone,
        qualifyingOrdersCount: 0,
        lastOrderWeek: null
      };
    }

    // Sort ascending by order timestamp
    qualifyingOrders.sort(function (a, b) {
      var tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      var tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tA - tB;
    });

    if (mode === 'drop_cycles') {
      // Group by dropId or cycle index
      var distinctDrops = [];
      qualifyingOrders.forEach(function (o) {
        var dropId = o.dropId || (o.dropCycle !== undefined ? 'drop_' + o.dropCycle : null);
        if (dropId && distinctDrops.indexOf(dropId) === -1) {
          distinctDrops.push(dropId);
        }
      });
      var dropStreak = distinctDrops.length;
      var nextDropMilestone = getMilestoneForStreak(dropStreak + 1, cfg);
      return {
        currentStreak: dropStreak,
        hasOrderedThisPeriod: false,
        graceActive: false,
        nextMilestone: nextDropMilestone,
        qualifyingOrdersCount: qualifyingOrders.length,
        lastOrderWeek: null
      };
    }

    // Calendar week calculations
    // Group orders by week start timestamp
    var weekMap = {};
    var orderedWeeks = [];
    qualifyingOrders.forEach(function (o) {
      var t = o.createdAt ? new Date(o.createdAt).getTime() : now;
      var wStart = getStartOfWeek(t);
      if (!weekMap[wStart]) {
        weekMap[wStart] = [];
        orderedWeeks.push(wStart);
      }
      weekMap[wStart].push(o);
    });

    orderedWeeks.sort(function (a, b) { return a - b; });

    // Walk forward through weeks and compute streak
    var streak = 0;
    var prevWeek = null;

    orderedWeeks.forEach(function (w) {
      if (prevWeek === null) {
        streak = 1;
      } else {
        var diff = getWeeksDifference(prevWeek, w);
        if (diff === 1) {
          // Exactly next week
          streak += 1;
        } else if (diff === 2 && mode === 'calendar_grace') {
          // 1 week skipped, grace saves the streak and counts this new week
          streak += 1;
        } else {
          // Missed 2+ weeks (or 1+ in strict mode) -> streak resets to 1
          streak = 1;
        }
      }
      prevWeek = w;
    });

    var currentWeekStart = getStartOfWeek(now);
    var diffFromCurrent = getWeeksDifference(prevWeek, currentWeekStart);

    var hasOrderedThisPeriod = (diffFromCurrent === 0);
    var graceActive = false;

    if (diffFromCurrent === 0) {
      // Ordered this week; streak is active
    } else if (diffFromCurrent === 1) {
      // Haven't ordered yet this current week, streak is still alive from last week!
    } else if (diffFromCurrent === 2 && mode === 'calendar_grace') {
      // Missed last week, but within 1-week grace!
      graceActive = true;
    } else {
      // Streak lapsed before this week
      streak = 0;
    }

    var nextTargetStreak = (hasOrderedThisPeriod ? streak + 1 : (streak === 0 ? 1 : streak + 1));
    var nextMilestone = getMilestoneForStreak(nextTargetStreak, cfg);

    return {
      currentStreak: streak,
      hasOrderedThisPeriod: hasOrderedThisPeriod,
      graceActive: graceActive,
      nextMilestone: nextMilestone,
      qualifyingOrdersCount: qualifyingOrders.length,
      lastOrderWeek: prevWeek
    };
  }

  /**
   * Format user-facing motivational copy for storefront header and cart sheet.
   */
  function getStreakMessaging(streakInfo, cartSubtotal, config) {
    var info = streakInfo || { currentStreak: 0, hasOrderedThisPeriod: false, graceActive: false };
    var cfg = config || DEFAULT_CONFIG;
    var minSpend = Number(cfg.minSpend) || 2.50;
    var subtotal = Number(cartSubtotal) || 0;
    var nextM = info.nextMilestone || { step: 3, label: 'Free Airheads Bar' };

    var bannerText = '';
    var bannerBadge = '';

    if (info.currentStreak === 0) {
      bannerBadge = '🔥 Start a Streak';
      bannerText = 'Order $' + minSpend.toFixed(2) + '+ this week to start earning free milestone rewards!';
    } else if (info.hasOrderedThisPeriod) {
      bannerBadge = '🔥 ' + info.currentStreak + '-Week Streak Active!';
      bannerText = 'You ordered this week! Next up: ' + nextM.label + ' at Week ' + nextM.targetStreak + '.';
    } else if (info.graceActive) {
      bannerBadge = '⚠️ ' + info.currentStreak + '-Week Streak on Grace!';
      bannerText = 'Order $' + minSpend.toFixed(2) + '+ this week to rescue your streak before it resets!';
    } else {
      bannerBadge = '🔥 ' + info.currentStreak + '-Week Streak!';
      bannerText = 'Order $' + minSpend.toFixed(2) + '+ this week to reach Week ' + (info.currentStreak + 1) + ' (' + nextM.label + ')!';
    }

    var cartQualified = (subtotal >= minSpend);
    var cartNudge = '';
    if (cartQualified) {
      cartNudge = '✅ This order qualifies for your weekly streak!';
    } else {
      var missing = minSpend - subtotal;
      cartNudge = 'Add $' + missing.toFixed(2) + ' more to qualify for your weekly streak!';
    }

    return {
      bannerBadge: bannerBadge,
      bannerText: bannerText,
      cartQualified: cartQualified,
      cartNudge: cartNudge,
      minSpend: minSpend
    };
  }

  /**
   * Motivational micro-copy string for streak status.
   */
  function getStreakStatusMessage(streakInfo, config) {
    var msg = getStreakMessaging(streakInfo, 0, config);
    return msg.bannerBadge + ' ' + msg.bannerText;
  }

  /**
   * Plan how to reverse a streak milestone reward when an order is cancelled.
   */
  function collectStreakReversal(order) {
    if (!order || !order.streakReward || order.streakReversed === true) return null;
    var reward = order.streakReward;
    var name = (order.studentInfo && order.studentInfo.name) || order.name;
    var className = (order.studentInfo && order.studentInfo.class) || order.className;
    if (!name || !className) return null;

    if (reward.type === 'free_bar') {
      return {
        type: 'free_bar',
        qty: Math.max(0, Number(reward.qty) || 1),
        path: 'students/' + name + '/' + className + '/freeItems'
      };
    } else if (reward.type === 'credit') {
      var amount = Math.max(0, Number(reward.amount) || 0);
      return {
        type: 'credit',
        amount: Math.round(amount * 100) / 100,
        path: 'students/' + name + '/' + className + '/credit'
      };
    }
    return null;
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    getStartOfWeek: getStartOfWeek,
    getWeeksDifference: getWeeksDifference,
    getMilestoneForStreak: getMilestoneForStreak,
    evaluateMilestoneReward: evaluateMilestoneReward,
    computeStreak: computeStreak,
    getStreakMessaging: getStreakMessaging,
    getStreakStatusMessage: getStreakStatusMessage,
    collectStreakReversal: collectStreakReversal
  };
});

