// ============================================================
// access-control.js -- who may call which /api route, and the check every /api request passes through
// Loaded by: server.js (accessHook is the check every /api request goes through;
// requireRole and notOwnAccount are handed on to the route files).
// Never sent to a browser.
// ============================================================

const roles = require("./roles");
const ADMIN = roles.ADMIN;
const MANAGER = roles.MANAGER;
const CLERK = roles.CLERK;
const CASHIER = roles.CASHIER;
const DRIVER = roles.DRIVER;
const MANAGEMENT = roles.MANAGEMENT;
const sessionState = require("./sessions").sessionState;
const liveChanges = require("./live-changes");
const scopeOf = liveChanges.scopeOf;
const recordChange = liveChanges.recordChange;
const features = require("./features");
const featuresCovering = features.featuresCovering;
const heldFeatures = features.heldFeatures;
const migrations = require("./database/migrations");
const EXPECTED_PROCEDURES = migrations.EXPECTED_PROCEDURES;
const proceduresAreMissing = migrations.proceduresAreMissing;
const proceduresLoadedCount = migrations.proceduresLoadedCount;
const procedureAdvice = migrations.procedureAdvice;

// ==========================================
// ACCESS CONTROL -- the whole policy in one table. Rules are matched in
// order, first match wins, and anything under /api with no rule is refused.
// ==========================================

const PUBLIC = "public";              // no session needed
const SIGNED_IN = "signed-in";        // any role, just not a stranger

// Each rule is: [ HTTP method, address pattern, who may use it ].
// How to read an address pattern (a "regular expression"):
//   ^  = the start of the address      $  = the end of the address
//   \/ = a "/" character               \d+ = one or more digits (an id)
//   [^/]+ = any text without a "/"     [a-z0-9-]+ = lowercase letters, digits or "-"
// So /^\/api\/users\/\d+$/ means exactly "/api/users/<some number>".
const ACCESS_RULES = [
  // --- authentication ---
  ["POST",  /^\/api\/login$/,                          PUBLIC],
  // the daily job (Vercel Cron); the route checks CRON_SECRET itself
  ["GET",   /^\/api\/cron\/daily$/,                    PUBLIC],
  // "Forgot your password?": a code by email, the code checked, then a new password.
  // Nobody is signed in yet, so all three are open; the routes ration the codes.
  ["POST",  /^\/api\/password-reset\/request$/,         PUBLIC],
  ["POST",  /^\/api\/password-reset\/verify$/,          PUBLIC],
  ["POST",  /^\/api\/password-reset\/confirm$/,         PUBLIC],
  ["POST",  /^\/api\/logout$/,                         SIGNED_IN],
  ["POST",  /^\/api\/change-password$/,                SIGNED_IN],
  ["POST",  /^\/api\/heartbeat$/,                      SIGNED_IN],
  ["GET",   /^\/api\/events\/poll$/,                    SIGNED_IN],
  ["GET",   /^\/api\/events\/status$/,                  SIGNED_IN],

  // --- your own account, any role ---
  ["GET",   /^\/api\/me$/,                             SIGNED_IN],
  ["GET",   /^\/api\/me\/access$/,                      SIGNED_IN],
  ["PUT",   /^\/api\/me$/,                             SIGNED_IN],
  ["POST",  /^\/api\/me\/password$/,                   SIGNED_IN],

  // --- staff accounts, administrator only ---
  // A manager given the Account Management screen (see FEATURES) also gets
  // the lookups, the two create steps and the held list below; the routes then
  // narrow them to the roles in ROLES_MANAGED_BY_MANAGER.
  ["GET",   /^\/api\/roles$/,                          [ADMIN]],
  ["GET",   /^\/api\/users$/,                          [ADMIN]],
  ["GET",   /^\/api\/users\/email-check$/,              [ADMIN]],
  ["GET",   /^\/api\/users\/phone-check$/,              [ADMIN]],
  // accounts on a sign-in hold
  ["GET",   /^\/api\/users\/held$/,                    [ADMIN]],
  ["GET",   /^\/api\/users\/\d+$/,                     [ADMIN]],
  // the review step creates nothing but does make a readable password
  ["POST",  /^\/api\/users\/draft$/,                    [ADMIN]],
  ["POST",  /^\/api\/users$/,                          [ADMIN]],
  ["PUT",   /^\/api\/users\/\d+$/,                     [ADMIN]],
  ["PATCH", /^\/api\/users\/\d+\/status$/,             [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/account\/draft$/,      [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/account$/,            [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/reset-password$/,     [ADMIN]],
  // (a manager reaches this one the same way, for Cashier, Clerk and Driver accounts only)
  ["POST",  /^\/api\/users\/\d+\/release-hold$/,       [ADMIN]],

  ["GET",   /^\/api\/audit-logs$/,                     [ADMIN]],
  ["GET",   /^\/api\/audit-logs\/types$/,              [ADMIN]],
  ["GET",   /^\/api\/audit-logs\/export\/(xlsx|pdf)$/,  [ADMIN]],

  // --- which screens each role holds ---
  ["GET",   /^\/api\/me\/features$/,                    SIGNED_IN],
  ["GET",   /^\/api\/features$/,                        [ADMIN]],
  ["PUT",   /^\/api\/features\/[a-z0-9-]+\/roles\/\d+$/, [ADMIN]],

  // --- backup and recovery, administrator only ---
  ["GET",    /^\/api\/backups$/,                       [ADMIN]],
  ["POST",   /^\/api\/backups$/,                       [ADMIN]],
  ["PUT",    /^\/api\/backups\/auto$/,                 [ADMIN]],
  ["GET",    /^\/api\/backups\/[^/]+$/,                [ADMIN]],
  ["DELETE", /^\/api\/backups\/[^/]+$/,                [ADMIN]],
  ["POST",   /^\/api\/backups\/[^/]+\/restore$/,       [ADMIN]],
  ["POST",   /^\/api\/restore$/,                       [ADMIN]],

  // --- manager reporting ---
  ["GET",   /^\/api\/manager\/summary$/,               [MANAGER]],
  ["GET",   /^\/api\/reports\/overview$/,              [MANAGER]],
  ["GET",   /^\/api\/reports\/activity$/,              [MANAGER]],
  ["GET",   /^\/api\/reports\/income$/,                [MANAGER]],
  ["GET",   /^\/api\/stocks$/,                         [MANAGER]],
  ["PUT",   /^\/api\/stocks\/\d+\/reorder-policy$/,    [MANAGER]],
  // the selling price is the manager's to set; the clerk counts, the manager prices
  ["PUT",   /^\/api\/stocks\/\d+\/price$/,             [MANAGER]],

  // exporting is the line between the reporting roles; a hidden button is still a URL
  ["POST",  /^\/api\/reports\/spreadsheet$/,          [MANAGER]],
  ["GET",   /^\/api\/reports\/export$/,                [MANAGER]],
  ["GET",   /^\/api\/reports\/daily-tally$/,           [MANAGER, CLERK, CASHIER, DRIVER]],

  // --- selling ---
  ["POST",  /^\/api\/sales$/,                          [CASHIER]],
  ["GET",   /^\/api\/sales\/undelivered$/,             [CASHIER, MANAGER]],
  ["GET",   /^\/api\/sales$/,                          [CASHIER, MANAGER]],
  ["GET",   /^\/api\/sales\/\d+$/,                     [CASHIER, MANAGER]],
  ["POST",  /^\/api\/sales\/\d+\/payment$/,            [CASHIER, MANAGER]],
  ["GET",   /^\/api\/cashier\/summary$/,               [CASHIER]],

  // --- GCash or Maya paid by QR code (routes/qr-payments.js): wherever
  // money is taken, a sale or a balance. A cashier's list is their own. ---
  ["POST",  /^\/api\/qr-payments$/,                    [CASHIER, MANAGER]],
  ["GET",   /^\/api\/qr-payments$/,                    [CASHIER, MANAGER]],
  ["GET",   /^\/api\/qr-payments\/\d+$/,               [CASHIER, MANAGER]],
  ["POST",  /^\/api\/qr-payments\/\d+\/cancel$/,       [CASHIER, MANAGER]],
  // PayMongo itself, with no session; its signature is the permission
  ["POST",  /^\/api\/paymongo\/webhook$/,              PUBLIC],

  // --- deliveries ---
  ["POST",  /^\/api\/deliveries$/,                     [CASHIER, MANAGER]],
  ["GET",   /^\/api\/deliveries$/,                     [CASHIER, MANAGER, DRIVER]],
  ["GET",   /^\/api\/deliveries\/drivers$/,            [CASHIER, MANAGER]],
  ["GET",   /^\/api\/deliveries\/\d+\/items$/,         [CASHIER, MANAGER, DRIVER, CLERK]],
  ["PATCH", /^\/api\/deliveries\/\d+\/status$/,        [DRIVER, MANAGER]],
  ["GET",   /^\/api\/delivery\/list$/,                 [DRIVER]],
  ["GET",   /^\/api\/delivery\/summary$/,              [DRIVER]],
  ["POST",  /^\/api\/delivery\/\d+\/claim$/,           [DRIVER]],
  ["POST",  /^\/api\/delivery\/\d+\/payment$/,         [DRIVER]],

  // --- inventory ---
  ["GET",   /^\/api\/inventory\/summary$/,             [CLERK, MANAGER]],
  ["GET",   /^\/api\/inventory\/products$/,            [CLERK, CASHIER, MANAGER]],
  // the sizes a material also sells in: the clerk keeps them, the till reads them
  ["GET",   /^\/api\/inventory\/products\/\d+\/units$/,       [CLERK, CASHIER, MANAGER]],
  ["POST",  /^\/api\/inventory\/products\/\d+\/units$/,       [CLERK]],
  ["DELETE", /^\/api\/inventory\/products\/\d+\/units\/\d+$/, [CLERK]],
  // how a material is delivered (a box of 20 kilogram); the clerk keeps it
  ["PUT",   /^\/api\/inventory\/products\/\d+\/pack$/,        [CLERK]],
  ["GET",   /^\/api\/inventory\/adjustments$/,         [CLERK]],
  ["POST",  /^\/api\/inventory\/adjust$/,              [CLERK]],
  ["PUT",   /^\/api\/inventory\/reorder\/\d+$/,        [CLERK]],

  // suppliers, categories and units are the manager's to add and correct
  ["POST",  /^\/api\/suppliers$/,                     [MANAGER]],
  ["POST",  /^\/api\/categories$/,                    [MANAGER]],
  ["POST",  /^\/api\/units$/,                         [MANAGER]],
  ["PUT",   /^\/api\/units\/\d+$/,                     [MANAGER]],

  // purchase orders: the clerk raises one and, once the manager has confirmed
  // it, counts the delivery in; the manager only confirms or declines
  ["GET",   /^\/api\/purchase-orders$/,                [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/items$/,    [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/document$/, [CLERK, MANAGER]],
  // a received order beside what arrived: the clerk's Reference card
  ["GET",   /^\/api\/purchase-orders\/\d+\/reference$/, [CLERK]],
  ["POST",  /^\/api\/purchase-orders$/,                [CLERK]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/decide$/,   [MANAGER]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/receive$/,  [CLERK]],
  // once approved, the clerk prints the order and may email it to the supplier
  ["POST",  /^\/api\/purchase-orders\/\d+\/send$/,     [CLERK]],
  // the supplier, who has no account, opens the order from the link or QR code
  // on the printed order; the code (43 url-safe characters) is the whole of the permission
  ["GET",   /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}$/,          PUBLIC],
  ["GET",   /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}\/pdf$/,     PUBLIC],
  ["POST",  /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}\/respond$/, PUBLIC],

  // opening a record for a material the shop has never stocked
  ["POST",  /^\/api\/materials$/,                      [CLERK]],

  // --- returns, damage and refunds ---
  ["GET",   /^\/api\/returns$/,                        [CLERK, CASHIER]],
  // the driver files a refund at the customer's door; the route checks it is
  // a delivery they took, and only the one report type (see inventory-clerk.js)
  ["POST",  /^\/api\/returns$/,                        [CLERK, CASHIER, DRIVER]],
  // the clerk's Make a Report: several items, one report, filed together
  ["POST",  /^\/api\/returns\/batch$/,                 [CLERK]],
  ["POST",  /^\/api\/returns\/\d+\/resolve$/,          [CLERK]],

  // --- credit management ---
  // reading is a counter action; changing a limit is a manager action
  ["GET",   /^\/api\/credit\/customers$/,              [MANAGER, CASHIER]],
  ["GET",   /^\/api\/credit\/customers\/\d+$/,         [MANAGER, CASHIER]],
  // every sale still carrying a balance, for taking payments at the counter
  ["GET",   /^\/api\/credit\/open-sales$/,             [MANAGER, CASHIER]],
  ["PUT",   /^\/api\/credit\/customers\/\d+\/limit$/,  [MANAGER]],
  // the late-payment policy: everyone who works with credit records reads it, the manager sets it
  ["GET",   /^\/api\/credit\/policy$/,                 [MANAGER, CASHIER]],
  ["PUT",   /^\/api\/credit\/policy$/,                 [MANAGER]],
  ["GET",   /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests\/\d+\/decide$/,  [MANAGER]],
  ["GET",   /^\/api\/customers\/\d+\/history$/,        [MANAGER, CASHIER]],

  // opening an account is a counter action; giving it a limit is not
  ["POST",  /^\/api\/customers$/,                      [MANAGER, CASHIER]],

  // --- shared lookups and archives ---
  ["GET",   /^\/api\/records\/\w+$/,                   [MANAGER, CASHIER, CLERK]],
  ["GET",   /^\/api\/archives$/,                       MANAGEMENT],
  ["POST",  /^\/api\/archives\/archive$/,              [CLERK, ADMIN, MANAGER]],
  ["POST",  /^\/api\/archives\/restore$/,              [CLERK, ADMIN, MANAGER]],

  // --- who the shop is, and how it is registered ---
  // every dashboard prints an invoice, so reading is open; changing is the administrator's
  ["GET",   /^\/api\/store-settings$/,                 SIGNED_IN],
  ["PUT",   /^\/api\/store-settings$/,                 [ADMIN]],

  // --- notifications ---
  ["GET",   /^\/api\/notifications$/,                  SIGNED_IN],
  ["POST",  /^\/api\/notifications\/\d+\/read$/,       SIGNED_IN],
  ["POST",  /^\/api\/notifications\/read-all$/,        SIGNED_IN]
];

// POSTs that touch no table, so the write hook below does not announce them.
const CHANGES_NOTHING = [
  /^\/api\/users\/draft$/,
  /^\/api\/users\/\d+\/account\/draft$/
];

// Every /api request is checked against the table above. Routes that destroy
// or replace data carry requireRole as well, so a loosened rule in the table
// still meets a no in the route.
//
// Use it like this:  app.delete("/api/x", requireRole(ADMIN), handler)
// or with a list:    requireRole([ADMIN, MANAGER])
// It gives back a small "middleware" function that Express runs first.
function requireRole(roles) {
  // accept one role name or a list of role names
  let allowed = roles;
  if (!Array.isArray(roles)) {
    allowed = [roles];
  }

  return function (request, response, next) {
    if (!request.actor || !allowed.includes(request.actor.roleName)) {
      let who = "visitor";
      if (request.actor) {
        who = request.actor.roleName;
      }
      return response.status(403).json({ error: "A " + who + " cannot use this feature." });
    }
    next();   // allowed: go on to the real route
  };
}

// An administrator does not edit their own record: rename, re-role,
// deactivate and reset are refused for the signed-in person. A second
// administrator makes those changes and is on the trail for them. The
// password stays in their own hands through My Account.
function notOwnAccount(request, response, next) {
  if (request.actor && Number(request.params.staffId) === Number(request.actor.staffId)) {
    return response.status(403).json({
      error: "You cannot change your own account from here. " +
             "Ask another administrator to make this change."
    });
  }
  next();
}

// finds who may use a route; null means no rule (so it is refused)
function findRule(method, pathname) {
  for (let ruleIndex = 0; ruleIndex < ACCESS_RULES.length; ruleIndex++) {
    const rule = ACCESS_RULES[ruleIndex];
    const ruleMethod = rule[0];
    const pattern = rule[1];
    const allowed = rule[2];
    if (ruleMethod === method && pattern.test(pathname)) {
      return allowed;
    }
  }
  return null;
}

// The check every request goes through (server.js: app.use(accessHook)). It
// applies the table above and the screens by role, and announces each write.
async function accessHook(request, response, next) {
  // A path like /API/backups is still an API call, so the check below must
  // not be skipped just because the letters are in a different case. Only the
  // exact lowercase /api/ is real; any other case is refused outright. Only
  // the first five letters are compared: the rest of the path may have capital
  // letters (a supplier-order code is mixed case).
  const lower = request.path.toLowerCase();
  if (lower.startsWith("/api/") && !request.path.startsWith("/api/")) return response.status(404).json({ error: "Not found" });
  if (!lower.startsWith("/api/")) return next();

  const allowed = findRule(request.method, request.path);

  if (allowed === null) {
    return response.status(403).json({ error: "This feature is not available." });
  }

  // With no procedures, reads still work and writes cannot: writes are stopped
  // here with the sentence that names the fix. Sign-in is exempt.
  const isWrite = request.method !== "GET" && request.method !== "HEAD";
  const isSignIn = request.path === "/api/login" || request.path === "/api/logout" ||
                   request.path === "/api/heartbeat" ||
                   request.path.startsWith("/api/password-reset/");

  if (isWrite && !isSignIn && (await proceduresAreMissing())) {
    console.error("Refused " + request.method + " " + request.path + ": " +
      proceduresLoadedCount() + " of " + EXPECTED_PROCEDURES + " stored procedures are loaded.");
    return response.status(503).json({ error: procedureAdvice() });
  }

  if (allowed === PUBLIC) return next();

  const state = await sessionState(request);
  const session = state.session;
  if (!session) {
    // signedOut tells the screen to go back to sign-in, with the reason when
    // somebody else ended this session (signed in elsewhere, held, deactivated)
    return response.status(401).json({
      error: state.endedReason || "Your session has ended. Please sign in again.",
      signedOut: true,
      ended: Boolean(state.endedReason)
    });
  }

  const byRole = allowed === SIGNED_IN || allowed.includes(session.roleName);

  // Screens by role: a route is refused once every screen using it is off for
  // this role, and allowed past the role table when held by grant. The
  // administrator is never narrowed.
  let covering = [];
  if (session.roleName !== ADMIN) {
    covering = featuresCovering(request.method, request.path);
  }
  if (covering.length > 0) {
    let held;
    try {
      held = await heldFeatures(session.roleName);
    } catch (error) {
      // (held and granted are objects of screen keys, the same shape heldFeatures() gives back)
      held = { held: {}, granted: {} };
    }

    // the screens using this route that the role still has switched on
    const stillHeld = [];
    for (let featureIndex = 0; featureIndex < covering.length; featureIndex++) {
      const feature = covering[featureIndex];
      if (held.held[feature.key] === true) {
        stillHeld.push(feature);
      }
    }
    if (stillHeld.length === 0) {
      return response.status(403).json({
        error: covering[0].name + " has been switched off for " + session.roleName + " accounts. " +
               "The System Administrator turns screens on and off under Access Control."
      });
    }

    // was one of those screens given to the role by the administrator?
    let givenByGrant = false;
    for (let featureIndex = 0; featureIndex < stillHeld.length; featureIndex++) {
      const feature = stillHeld[featureIndex];
      if (held.granted[feature.key] === true) {
        givenByGrant = true;
      }
    }

    if (!byRole && !givenByGrant) {
      return response.status(403).json({
        error: "A " + session.roleName + " cannot use this feature."
      });
    }
  } else if (!byRole) {
    return response.status(403).json({
      error: "A " + session.roleName + " cannot use this feature."
    });
  }

  request.actor = session;

  // Every write passes through here, so this is where a change is announced
  // from, only when it succeeded. The change is written just before the
  // answer goes out, so it is safe in the database even if the server is
  // frozen the moment the answer is sent (Vercel), and the screen that made
  // the write never sees an older version than its own change.
  let changesNothing = false;
  for (let patternIndex = 0; patternIndex < CHANGES_NOTHING.length; patternIndex++) {
    const pattern = CHANGES_NOTHING[patternIndex];
    if (pattern.test(request.path)) {
      changesNothing = true;
    }
  }

  const scope = scopeOf(request.path);
  if (request.method !== "GET" && request.method !== "HEAD" && !changesNothing && scope) {
    const sendAnswer = response.end;
    response.end = function () {
      // the arguments response.end was called with, passed on unchanged
      const endArguments = arguments;
      response.end = sendAnswer;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return sendAnswer.apply(response, endArguments);
      }
      recordChange(scope, request.method + " " + request.path, request.headers["x-client-id"] || null)
        .finally(function () {
          sendAnswer.apply(response, endArguments);
        });
      return response;
    };
  }

  next();
}

module.exports = { requireRole: requireRole, notOwnAccount: notOwnAccount, accessHook: accessHook };
