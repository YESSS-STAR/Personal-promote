/**
 * tests/ui-check.js
 * ---------------------------------------------------------------------------
 * Optional headless UI verification for both changes.
 *
 * Loads the REAL index.html and admin.html in headless Chrome and drives their
 * real code (renderGrid, getVolumeDiscount, the checkout handler,
 * applyOrderStatusChange) against an in-memory stub of Firebase, so nothing
 * here depends on the live database or the network.
 *
 * Scenario 1 - storefront: settings/marketing from the database changes what the
 *   shopper sees (anchored prices, scarcity, social proof), the volume ladder and
 *   rebate land in the cart, and a placed order records the right amounts.
 *
 * Scenario 2 - admin: cancelling an order through the real Cancel button puts the
 *   stock back, frees the bundle slot, claws back the rebate credit, and is
 *   idempotent when the status change is re-applied.
 *
 * Usage (the pages must be served first):
 *   python -m http.server 8123
 *   node tests/ui-check.js                     # defaults to 127.0.0.1:8123
 *   UI_CHECK_URL=http://127.0.0.1:8123 node tests/ui-check.js
 *
 * Requires a local Chrome/Edge/Chromium. Set CHROME_PATH to override detection.
 * Not part of `npm test` - it needs a browser, so it is opt-in.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_URL = (process.env.UI_CHECK_URL || 'http://127.0.0.1:8123').replace(/\/$/, '');
const STOREFRONT_URL = `${BASE_URL}/index.html`;
const ADMIN_URL = `${BASE_URL}/admin.html`;
const ADMIN_PASSWORD = 'haniqo'; // hardcoded in admin.html

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Chrome discovery / launch / CDP
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

async function waitForJson(url, attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (err) { /* not up yet */ }
    await sleep(delayMs);
  }
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = [];
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data || '')}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        this.eventHandlers.slice().forEach((h) => h(msg));
      }
    });
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
    ws.addEventListener('error', (err) => reject(new Error(`WebSocket failed: ${err.message || err}`)));
  });
}

// ---------------------------------------------------------------------------
// The in-memory Firebase stub, injected before any page script runs
// ---------------------------------------------------------------------------

const TODAY_MS = Date.now() - 60 * 60 * 1000; // an hour ago, safely "today"

function fakeFirebaseSource(seed) {
  return `(function(){
  var data = ${JSON.stringify(seed)};
  function keys(p){ return String(p).split('/').filter(Boolean); }
  function get(p){ return keys(p).reduce(function(n,k){ return (n && typeof n === 'object') ? n[k] : undefined; }, data); }
  function set(p,v){
    var ks = keys(p), n = data;
    for(var i=0;i<ks.length-1;i++){ if(typeof n[ks[i]] !== 'object' || n[ks[i]] === null) n[ks[i]] = {}; n = n[ks[i]]; }
    n[ks[ks.length-1]] = v;
  }
  function remove(p){
    var ks = keys(p), n = data;
    for(var i=0;i<ks.length-1;i++){ if(typeof n[ks[i]] !== 'object') return; n = n[ks[i]]; }
    delete n[ks[ks.length-1]];
  }
  function clone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function snap(p){ return { val: function(){ return clone(get(p)); } }; }

  var listeners = [];
  function notify(){
    listeners.slice().forEach(function(l){
      try { l.cb(snap(l.path)); } catch(e){ console.error('listener error', e); }
    });
  }

  var counter = 0;
  function makeRef(p){
    return {
      key: null,
      child: function(k){ return makeRef(p + '/' + k); },
      once: function(){ return Promise.resolve(snap(p)); },
      on: function(event, cb){
        listeners.push({ path: p, cb: cb });
        setTimeout(function(){ try { cb(snap(p)); } catch(e){ console.error(e); } }, 0);
      },
      off: function(){ },
      set: function(v){ set(p, clone(v)); notify(); return Promise.resolve(); },
      remove: function(){ remove(p); notify(); return Promise.resolve(); },
      push: function(){
        var k = 'k' + (++counter);
        var r = makeRef(p + '/' + k);
        r.key = k;
        return r;
      },
      transaction: function(fn){
        var cur = clone(get(p));
        var next = fn(cur);
        if(next === undefined) return Promise.resolve({ committed: false, snapshot: snap(p) });
        set(p, clone(next)); notify();
        return Promise.resolve({ committed: true, snapshot: { val: function(){ return clone(next); } } });
      }
    };
  }

  var ServerValue = { TIMESTAMP: ${Date.now()} };
  function Database(){ this.ref = function(p){ return makeRef(p); }; }
  Database.ServerValue = ServerValue;

  var instance = new Database();
  window.firebase = {
    initializeApp: function(){},
    database: function(){ return instance; }
  };
  window.firebase.database.ServerValue = ServerValue;
  window.__FAKE_DB__ = data;
})();`;
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const STOREFRONT_SEED = {
  inventory: {
    Orange: { price: 1.25, stock: 20 },
    'Blue Raspberry': { price: 1.25, stock: 11 },
    Grape: { price: 1.25, stock: 7 },
    Watermelon: { price: 1.25, stock: 9 },
    Cherry: { price: 1.25, stock: 4 },
    'White Mystery': { price: 1.25, stock: 2 }
  },
  bundles: {},
  coupons: {},
  settings: {
    upsale: { threshold: 1.2, price: 0.9, flavor: 'Orange' },
    referral: { rate: 0.15 },
    // Deliberately NOT the built-in defaults, so the assertions prove the page
    // really reads settings/marketing from the database.
    marketing: {
      cost: 0.61,
      targetMarkup: 1.0,
      anchorUplift: 0.35,
      scarcityThreshold: 3,
      socialProofFloor: 5,
      rebateCap: 2.0,
      volumeTiers: [{ qty: 2, percent: 10 }, { qty: 6, percent: 20 }],
      rebateTiers: [{ minSpend: 2, rate: 10 }, { minSpend: 4, rate: 20 }],
      enabled: { charm: true, anchor: true, volume: true, rebate: true, scarcity: true, socialProof: true }
    }
  },
  // 12 bars sold today across three live orders, plus one cancelled order that
  // must NOT be counted.
  orders: {
    o1: {
      name: 'Earlier', className: 'Sec 1', status: 'paid', total: 6.25, createdAt: TODAY_MS,
      items: [{ flavor: 'Orange', qty: 5, price: 1.25 }]
    },
    o2: {
      name: 'Earlier', className: 'Sec 2', status: 'pending', total: 3.75, createdAt: TODAY_MS,
      items: [{ flavor: 'Grape', qty: 3, price: 1.25 }]
    },
    o3: {
      name: 'Earlier', className: 'Sec 3', status: 'fulfilled', total: 5, createdAt: TODAY_MS,
      items: [{ bundle: 'gone', name: 'Pack', qty: 1, price: 5, components: { Cherry: 2, Watermelon: 2 } }]
    },
    cancelledOne: {
      name: 'Cancelled', className: 'Sec 9', status: 'cancelled', total: 99, createdAt: TODAY_MS,
      items: [{ flavor: 'Orange', qty: 40, price: 1.25 }]
    }
  }
};

/** The state a live shop would be in right after the order below was placed. */
const ADMIN_SEED = {
  inventory: {
    Orange: { price: 1.25, stock: 15 },
    'Blue Raspberry': { price: 1.25, stock: 11 },
    Grape: { price: 1.25, stock: 5 },
    Watermelon: { price: 1.25, stock: 9 },
    Cherry: { price: 1.25, stock: 6 },
    'White Mystery': { price: 1.25, stock: 6 }
  },
  bundles: {
    taster: { name: 'Taster pack', price: 4.5, soldCount: 2, maxSold: 10, active: true, components: { Orange: 1, Cherry: 2 } }
  },
  coupons: {},
  referrals: {},
  team: {},
  pending_approvals: {},
  students: {
    Aisyah: { 'Sec 2 Amanah': { credit: 5.02, freeItems: 0 } }
  },
  settings: {
    upsale: { threshold: 1.2, price: 0.9, flavor: 'Orange' },
    referral: { rate: 0.15 },
    marketing: {
      cost: 0.61,
      targetMarkup: 1.0,
      anchorUplift: 0.35,
      scarcityThreshold: 6,
      socialProofFloor: 5,
      rebateCap: 1.5,
      volumeTiers: [{ qty: 3, percent: 5 }, { qty: 5, percent: 10 }, { qty: 10, percent: 15 }],
      rebateTiers: [{ minSpend: 3, rate: 5 }, { minSpend: 5, rate: 8 }, { minSpend: 8, rate: 12 }],
      enabled: { charm: true, anchor: true, volume: true, rebate: true, scarcity: true, socialProof: true }
    }
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
      createdAt: TODAY_MS,
      items: [
        { flavor: 'Orange', qty: 4, price: 1.25 },
        { flavor: 'Grape', qty: 2, price: 1.25 },
        { flavor: 'Watermelon', qty: 1, price: 0, free: true },
        { bundle: 'taster', name: 'Taster pack', qty: 2, price: 4.5, components: { Orange: 1, Cherry: 2 } }
      ]
    }
  }
};

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function openSession(cdp, seed, label) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);

  // Surface page-level errors, otherwise a broken page just looks like "nothing
  // rendered" with no clue why.
  const errors = [];
  cdp.onEvent((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`Uncaught: ${d.exception ? (d.exception.description || d.exception.value) : d.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      const text = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? a.value : (a.description || a.type)))
        .join(' ');
      errors.push(`console.${msg.params.type}: ${text}`);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  // Block the real Firebase SDK so the injected stub is what the page sees.
  await send('Network.setBlockedURLs', {
    urls: ['*://*.gstatic.com/*', '*firebaseio.com*', '*firebasedatabase.app*']
  });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fakeFirebaseSource(seed) });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      throw new Error(ex.exception ? (ex.exception.description || ex.exception.value) : ex.text);
    }
    return result.result.value;
  };

  return { label, targetId, sessionId, send, evaluate, errors };
}

/**
 * Optional screenshots. Set UI_CHECK_SCREENSHOT_DIR to a folder and each named
 * step writes a PNG there - handy for eyeballing the result of a UI change.
 */
function makeShooter(session) {
  const dir = process.env.UI_CHECK_SCREENSHOT_DIR;
  if (!dir) return async () => {};
  fs.mkdirSync(dir, { recursive: true });
  return async (name) => {
    try {
      const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
    } catch (err) {
      console.log(`    (screenshot ${name} failed: ${err.message})`);
    }
  };
}

async function waitUntil(evaluate, expression, attempts = 60, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await evaluate(expression)) return true;
    } catch (err) { /* page still settling */ }
    await sleep(delayMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scenario 1 - the storefront
// ---------------------------------------------------------------------------

async function storefrontScenario(session) {
  const { evaluate } = session;
  const shoot = makeShooter(session);

  console.log('\nScenario 1 - storefront (real index.html, stubbed database)');

  const hydrated = await waitUntil(evaluate, "document.querySelectorAll('.flavor-card').length > 0");
  check('the storefront hydrates from the database', hydrated, 'no flavour cards rendered');
  if (!hydrated) throw new Error('page never rendered');

  equal('all six flavours render', await evaluate("document.querySelectorAll('.flavor-card').length"), 6);

  // ---- anchoring --------------------------------------------------------
  const orange = await evaluate(`(function(){
    var card = [].slice.call(document.querySelectorAll('.flavor-card')).filter(function(c){
      return c.querySelector('h3').textContent === 'Orange';
    })[0];
    var was = card.querySelector('.price-was');
    var save = card.querySelector('.price-save');
    return {
      price: card.querySelector('.price').textContent,
      was: was ? was.textContent : null,
      save: save ? save.textContent : null
    };
  })()`);

  equal('the live price is shown', orange.price, '$1.25');
  equal('the anchor "was" price is struck through beside it', orange.was, '$1.75');
  equal('the saving is spelled out', orange.save, 'Save $0.50');

  // ---- scarcity (threshold 3 comes from the database, not the default 6) ---
  const stockTags = await evaluate(`(function(){
    var out = {};
    [].slice.call(document.querySelectorAll('.flavor-card')).forEach(function(c){
      out[c.querySelector('h3').textContent] = c.querySelector('.stock-tag').textContent;
    });
    return out;
  })()`);

  equal('stock above the database threshold reads neutrally', stockTags.Cherry, '4 in stock');
  equal('near-empty stock escalates to last-chance urgency', stockTags['White Mystery'], 'Only 2 left - last chance');

  // ---- social proof ----------------------------------------------------
  const proof = await evaluate(`(function(){
    var el = document.getElementById('socialProofBadge');
    return { shown: el.style.display !== 'none', text: el.textContent };
  })()`);

  equal('the social proof badge is visible', proof.shown, true);
  equal("it counts today's bars and ignores the cancelled order", proof.text, '\uD83D\uDD25 12 sold today');

  // ---- volume ladder + rebate, driven through the real add buttons -------
  await evaluate(`(async function(){
    function click(sel){ var b = document.querySelector(sel); if(!b) throw new Error('missing ' + sel); b.click(); }
    click('button[data-action="add"][data-flavor="Orange"]');
    for(var i=0;i<3;i++){
      await new Promise(function(r){ setTimeout(r, 10); });
      click('button[data-action="inc"][data-flavor="Orange"]');
    }
    await new Promise(function(r){ setTimeout(r, 30); });
    return true;
  })()`);

  const cartState = await evaluate(`(function(){
    var v = getVolumeDiscount();
    return {
      units: cartPaidUnits(),
      percent: v.percent,
      amount: v.amount,
      unitsToNextTier: v.unitsToNextTier,
      subtotal: cartTotal()
    };
  })()`);

  equal('four bars are in the cart', cartState.units, 4);
  equal('the subtotal is the un-discounted sum', cartState.subtotal, 5);
  equal('the database volume tier is applied (10% at 2 bars)', cartState.percent, 10);
  equal('the volume discount amount is correct', cartState.amount, 0.5);
  equal('the shopper is told how far the next tier is', cartState.unitsToNextTier, 2);

  // ---- what the shopper actually sees in the cart sheet ------------------
  const sheet = await evaluate(`(function(){
    openCartSheet();
    return {
      subtotal: document.getElementById('sheetSubtotal').textContent,
      volumeVisible: document.getElementById('sheetVolumeRow').style.display !== 'none',
      volumeLabel: document.getElementById('sheetVolumeLabel').textContent,
      volumeAmt: document.getElementById('sheetVolumeAmt').textContent,
      nudge: document.getElementById('volumeNudge').textContent,
      rebateVisible: document.getElementById('rebateBanner').style.display !== 'none',
      rebate: document.getElementById('rebateText').textContent,
      total: document.getElementById('sheetTotal').textContent
    };
  })()`);

  equal('the cart shows the subtotal', sheet.subtotal, '$5.00');
  equal('a volume discount row appears', sheet.volumeVisible, true);
  equal('the row names the applied tier', sheet.volumeLabel, 'Volume discount (10% off)');
  equal('the row shows the money off', sheet.volumeAmt, '-$0.50');
  equal('the nudge pushes the next tier', sheet.nudge, '10% off applied. Add 2 more for 20% off');
  equal('the rebate panel appears', sheet.rebateVisible, true);
  equal('the rebate is 20% of the post-discount subtotal', sheet.rebate, 'You earn $0.90 store credit on this order');
  equal('the total has the volume discount off but not the rebate', sheet.total, '$4.50');
  await shoot('storefront-cart');

  // ---- checkout --------------------------------------------------------
  const order = await evaluate(`(async function(){
    var name = document.getElementById('buyerName');
    var cls = document.getElementById('buyerClass');
    name.value = 'Aisyah';
    cls.value = 'Sec 2 Amanah';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    cls.dispatchEvent(new Event('input', { bubbles: true }));

    document.getElementById('placeOrderBtn').click();
    for(var i=0;i<80;i++){
      await new Promise(function(r){ setTimeout(r, 50); });
      var keys = Object.keys(window.__FAKE_DB__.orders || {}).filter(function(k){ return k.indexOf('k') === 0; });
      if(keys.length){
        var o = window.__FAKE_DB__.orders[keys[0]];
        if(o && o.status) return { id: keys[0], order: o, orangeStock: window.__FAKE_DB__.inventory.Orange.stock };
      }
    }
    return null;
  })()`);

  check('placing the order writes a new order', !!order, 'no order was created');
  if (order) {
    equal('the order records the subtotal', order.order.subtotal, 5);
    equal('the order records the volume discount', order.order.volumeDiscount, 0.5);
    equal('the order records the rebate owed', order.order.rebateAmount, 0.9);
    equal('the order total excludes the rebate (credit, not a discount)', order.order.total, 4.5);
    equal('the order starts as pending', order.order.status, 'pending');
    equal('the four bars were reserved from stock', order.orangeStock, 16);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 - the admin panel
// ---------------------------------------------------------------------------

async function adminScenario(session) {
  const { evaluate } = session;
  const shoot = makeShooter(session);

  console.log('\nScenario 2 - admin cancellation (real admin.html, stubbed database)');

  // Wait for the document to finish loading before interacting: the login
  // elements exist as soon as they are parsed, but the inline script only wires
  // the click handler when the parser reaches the end of the body.
  await waitUntil(evaluate, "document.readyState === 'complete'", 40, 150);

  // Log in with the main admin password, exactly as staff would. The expression
  // returns false after clicking so the next poll re-checks; it is retried until
  // the dashboard is actually showing, which also covers a click that lands
  // before the handler is attached.
  const loggedIn = await waitUntil(evaluate, `(function(){
    var dash = document.getElementById('dash');
    if(dash && dash.style.display === 'block') return true;
    var pw = document.getElementById('pwInput');
    var btn = document.getElementById('loginBtn');
    if(!pw || !btn) return false;
    pw.value = ${JSON.stringify(ADMIN_PASSWORD)};
    btn.click();
    return false;
  })()`);

  check('the admin panel accepts the staff password', loggedIn, 'the dashboard never opened');

  const ordersRendered = await waitUntil(evaluate, "document.querySelectorAll('.order-card').length > 0");
  check('the pending order renders in the orders list', ordersRendered, 'no order cards rendered');
  if (!ordersRendered) {
    const diag = await evaluate(`(function(){
      function safe(id){ var el = document.getElementById(id); return el ? el.style.display : 'missing'; }
      return {
        url: location.href,
        hasPwInput: !!document.getElementById('pwInput'),
        loginWrap: safe('loginWrap'),
        dash: safe('dash'),
        firebaseReady: typeof firebaseReady === 'undefined' ? 'undefined' : firebaseReady,
        dashboardInitialized: typeof dashboardInitialized === 'undefined' ? 'undefined' : dashboardInitialized,
        orderCount: typeof currentOrders === 'undefined' ? 'undefined' : Object.keys(currentOrders).length,
        ordersListHtml: (document.getElementById('ordersList') || {}).innerHTML || '',
        seedOrderKeys: Object.keys(window.__FAKE_DB__.orders || {})
      };
    })()`);
    console.log('    diagnostics: ' + JSON.stringify(diag).slice(0, 1200));
    throw new Error('admin dashboard never populated');
  }

  const before = await evaluate('JSON.stringify(window.__FAKE_DB__.inventory)');
  check('stock starts at the post-order level', JSON.parse(before).Orange.stock === 15, before);

  // ---- the marketing tab -------------------------------------------------
  const marketing = await evaluate(`(function(){
    var results = document.getElementById('priceLadderResults').textContent;
    var book = document.getElementById('marketingPlaybook');
    return {
      hasShelfPrice: results.indexOf('$1.25') !== -1,
      hasLadder: results.indexOf('Regular price') !== -1,
      hasAnchor: results.indexOf('$1.75') !== -1,
      hasRebate: results.indexOf('% back') !== -1,
      playbookEntries: book ? book.querySelectorAll('.card').length : 0,
      mentionsReferenceCost: document.getElementById('marketingSection').textContent.indexOf('$0.61') !== -1
    };
  })()`);

  check('the marketing tab renders the recommended shelf price', marketing.hasShelfPrice);
  check('the price ladder is rendered', marketing.hasLadder);
  check('the anchor framing is rendered', marketing.hasAnchor);
  check('the rebate tiers are rendered', marketing.hasRebate);
  check('the strategy playbook lists every tactic', marketing.playbookEntries >= 10, `got ${marketing.playbookEntries}`);
  check('the $0.61 Airheads reference is surfaced to staff', marketing.mentionsReferenceCost);

  // Show the marketing tab itself before the cancellation shot.
  await evaluate("document.querySelector('.tab-btn[data-tab=\"marketing\"]').click()");
  await sleep(150);
  await shoot('admin-marketing-tab');

  // ---- cancel the order through the real Cancel button -------------------
  const cancelled = await evaluate(`(async function(){
    var btn = document.querySelector('.act-btn.cancel[data-id="order1"]');
    if(!btn) return { clicked: false };
    btn.click();
    for(var i=0;i<80;i++){
      await new Promise(function(r){ setTimeout(r, 50); });
      var o = window.__FAKE_DB__.orders.order1;
      if(o && o.status === 'cancelled' && o.stockRestored === true){
        return {
          clicked: true,
          inventory: window.__FAKE_DB__.inventory,
          bundleSold: window.__FAKE_DB__.bundles.taster.soldCount,
          credit: window.__FAKE_DB__.students.Aisyah['Sec 2 Amanah'].credit,
          rebateReversed: o.rebateReversed === true
        };
      }
    }
    return { clicked: true, timedOut: true };
  })()`);

  check('the Cancel button is present and clickable', cancelled.clicked);
  check('cancelling completes without timing out', !cancelled.timedOut);
  if (cancelled.timedOut) throw new Error('cancellation never completed');

  equal('the order is marked cancelled', true, true); // status asserted by the wait loop
  equal('Orange returns its 4 paid + 2 bundle bars', cancelled.inventory.Orange.stock, 21);
  equal('Grape returns its 2 bars', cancelled.inventory.Grape.stock, 7);
  equal('Cherry returns the 2x2 bundle components', cancelled.inventory.Cherry.stock, 10);
  equal('the free reward bar is returned too', cancelled.inventory.Watermelon.stock, 10);
  equal('flavours not in the order are untouched', cancelled.inventory['Blue Raspberry'].stock, 11);
  equal("the bundle's maxSold slot is freed", cancelled.bundleSold, 0);
  equal('the rebate credit is clawed back', cancelled.credit, 4);
  check('the rebate reversal is recorded on the order', cancelled.rebateReversed);

  // ---- idempotency ------------------------------------------------------
  const snapshot = await evaluate('JSON.stringify(window.__FAKE_DB__)');
  await evaluate("applyOrderStatusChange('order1', 'cancelled')");
  await sleep(300);
  const after = await evaluate('JSON.stringify(window.__FAKE_DB__)');

  check('re-applying the cancellation does not credit the stock twice', snapshot === after,
    'the database changed on a repeat cancellation');

  await evaluate("document.querySelector('.tab-btn[data-tab=\"orders\"]').click()");
  await sleep(150);
  await shoot('admin-after-cancel');
}

// ---------------------------------------------------------------------------

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('No Chrome/Edge/Chromium found - skipping the headless UI check.');
    console.log('Set CHROME_PATH to run it.');
    return;
  }

  try {
    const probe = await fetch(STOREFRONT_URL);
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (err) {
    console.log(`Cannot reach ${STOREFRONT_URL} (${err.message}).`);
    console.log('Start a server first:  python -m http.server 8123');
    process.exitCode = 1;
    return;
  }

  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = path.join(os.tmpdir(), `ui-check-${port}`);
  fs.rmSync(profile, { recursive: true, force: true });

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  const sessions = [];

  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`, 40, 250);
    if (!version) throw new Error('Chrome did not expose a debugging endpoint');
    cdp = await connect(version.webSocketDebuggerUrl);

    // --- storefront ---
    const storefront = await openSession(cdp, STOREFRONT_SEED, 'storefront');
    sessions.push(storefront);
    await storefront.send('Page.navigate', { url: STOREFRONT_URL });
    await storefrontScenario(storefront);

    // --- admin ---
    const admin = await openSession(cdp, ADMIN_SEED, 'admin');
    sessions.push(admin);
    await admin.send('Page.navigate', { url: ADMIN_URL });
    await adminScenario(admin);
  } catch (err) {
    failed++;
    failures.push('harness');
    console.log(`\n  \u2717 harness error: ${err.message}`);
  } finally {
    sessions.forEach((s) => {
      const interesting = s.errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
      if (interesting.length) {
        console.log(`\n  page errors reported by ${s.label}:`);
        interesting.slice(0, 12).forEach((e) => console.log(`    - ${e}`));
      }
    });
    try { if (cdp) await cdp.send('Browser.close'); } catch (err) { /* gone */ }
    try { chrome.kill(); } catch (err) { /* gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* windows lock */ }
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed checks:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  }
}

main();
