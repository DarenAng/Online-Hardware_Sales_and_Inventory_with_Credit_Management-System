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

const PUBLIC = "public";
const SIGNED_IN = "signed-in";

const ACCESS_RULES = [
  ["POST",  /^\/api\/login$/,                          PUBLIC],
  ["GET",   /^\/api\/cron\/daily$/,                    PUBLIC],
  ["POST",  /^\/api\/password-reset\/request$/,         PUBLIC],
  ["POST",  /^\/api\/password-reset\/verify$/,          PUBLIC],
  ["POST",  /^\/api\/password-reset\/confirm$/,         PUBLIC],

  // Customer portal: PUBLIC to the staff rules. Each route except sign-in checks the customer session itself.
  ["POST",  /^\/api\/portal\/login$/,                    PUBLIC],
  ["POST",  /^\/api\/portal\/logout$/,                   PUBLIC],
  ["GET",   /^\/api\/portal\/(me|account|credits|payments|loyalty)$/, PUBLIC],
  ["POST",  /^\/api\/portal\/password$/,                 PUBLIC],
  ["POST",  /^\/api\/portal\/qr-payments$/,              PUBLIC],
  ["GET",   /^\/api\/portal\/qr-payments\/\d+$/,         PUBLIC],
  ["POST",  /^\/api\/portal\/qr-payments\/\d+\/cancel$/, PUBLIC],


  ["POST",  /^\/api\/logout$/,                         SIGNED_IN],
  ["POST",  /^\/api\/change-password$/,                SIGNED_IN],
  ["POST",  /^\/api\/heartbeat$/,                      SIGNED_IN],
  ["GET",   /^\/api\/events\/poll$/,                    SIGNED_IN],
  ["GET",   /^\/api\/events\/status$/,                  SIGNED_IN],

  ["GET",   /^\/api\/me$/,                             SIGNED_IN],
  ["GET",   /^\/api\/me\/access$/,                      SIGNED_IN],
  ["PUT",   /^\/api\/me$/,                             SIGNED_IN],
  ["POST",  /^\/api\/me\/password$/,                   SIGNED_IN],

  ["GET",   /^\/api\/roles$/,                          [ADMIN]],
  ["GET",   /^\/api\/users$/,                          [ADMIN]],
  ["GET",   /^\/api\/users\/email-check$/,              [ADMIN]],
  ["GET",   /^\/api\/users\/phone-check$/,              [ADMIN]],
  ["GET",   /^\/api\/users\/held$/,                    [ADMIN]],
  ["GET",   /^\/api\/users\/\d+$/,                     [ADMIN]],
  ["POST",  /^\/api\/users\/draft$/,                    [ADMIN]],
  ["POST",  /^\/api\/users$/,                          [ADMIN]],
  ["PUT",   /^\/api\/users\/\d+$/,                     [ADMIN]],
  ["PATCH", /^\/api\/users\/\d+\/status$/,             [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/account\/draft$/,      [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/account$/,            [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/reset-password$/,     [ADMIN]],
  ["POST",  /^\/api\/users\/\d+\/release-hold$/,       [ADMIN]],

  ["GET",   /^\/api\/audit-logs$/,                     [ADMIN]],
  ["GET",   /^\/api\/audit-logs\/types$/,              [ADMIN]],
  ["GET",   /^\/api\/audit-logs\/export\/(xlsx|pdf)$/,  [ADMIN]],

  ["GET",   /^\/api\/me\/features$/,                    SIGNED_IN],
  ["GET",   /^\/api\/features$/,                        [ADMIN]],
  ["PUT",   /^\/api\/features\/[a-z0-9-]+\/roles\/\d+$/, [ADMIN]],

  ["GET",    /^\/api\/backups$/,                       [ADMIN]],
  ["POST",   /^\/api\/backups$/,                       [ADMIN]],
  ["PUT",    /^\/api\/backups\/auto$/,                 [ADMIN]],
  ["GET",    /^\/api\/backups\/[^/]+$/,                [ADMIN]],
  ["DELETE", /^\/api\/backups\/[^/]+$/,                [ADMIN]],
  ["POST",   /^\/api\/backups\/[^/]+\/restore$/,       [ADMIN]],
  ["POST",   /^\/api\/restore$/,                       [ADMIN]],

  ["GET",   /^\/api\/manager\/summary$/,               [MANAGER]],
  ["GET",   /^\/api\/reports\/overview$/,              [MANAGER]],
  ["GET",   /^\/api\/reports\/activity$/,              [MANAGER]],
  ["GET",   /^\/api\/reports\/income$/,                [MANAGER]],
  ["GET",   /^\/api\/stocks$/,                         [MANAGER]],
  ["GET",   /^\/api\/stocks\/unpriced$/,               [MANAGER]],
  ["PUT",   /^\/api\/stocks\/\d+\/reorder-policy$/,    [MANAGER]],
  ["PUT",   /^\/api\/stocks\/\d+\/price$/,             [MANAGER]],

  ["POST",  /^\/api\/reports\/spreadsheet$/,          [MANAGER]],
  ["GET",   /^\/api\/reports\/export$/,                [MANAGER]],
  ["GET",   /^\/api\/reports\/daily-tally$/,           [MANAGER, CLERK, CASHIER, DRIVER]],

  ["POST",  /^\/api\/sales$/,                          [CASHIER]],
  ["GET",   /^\/api\/sales\/undelivered$/,             [CASHIER, MANAGER]],
  ["GET",   /^\/api\/sales$/,                          [CASHIER, MANAGER]],
  ["GET",   /^\/api\/sales\/\d+$/,                     [CASHIER, MANAGER]],
  ["POST",  /^\/api\/sales\/\d+\/payment$/,            [CASHIER, MANAGER]],
  ["POST",  /^\/api\/sales\/\d+\/void$/,               MANAGEMENT],
  ["POST",  /^\/api\/sales\/\d+\/void-request$/,       [CASHIER]],
  ["GET",   /^\/api\/void-requests$/,                  MANAGEMENT],
  ["POST",  /^\/api\/void-requests\/\d+\/(approve|decline)$/, MANAGEMENT],
  ["GET",   /^\/api\/cashier\/summary$/,               [CASHIER]],

  ["POST",  /^\/api\/qr-payments$/,                    [CASHIER, MANAGER, DRIVER]],
  ["GET",   /^\/api\/qr-payments\/\d+$/,               [CASHIER, MANAGER, DRIVER]],
  ["POST",  /^\/api\/qr-payments\/\d+\/cancel$/,       [CASHIER, MANAGER, DRIVER]],
  ["POST",  /^\/api\/paymongo\/webhook$/,              PUBLIC],

  ["POST",  /^\/api\/deliveries$/,                     [CASHIER]],
  ["GET",   /^\/api\/deliveries$/,                     [CASHIER, MANAGER, DRIVER]],
  ["GET",   /^\/api\/deliveries\/drivers$/,            [CASHIER, MANAGER, CLERK]],
  ["GET",   /^\/api\/deliveries\/failed$/,             [MANAGER, CLERK]],
  ["GET",   /^\/api\/deliveries\/\d+\/attempts$/,      [MANAGER, CLERK]],
  ["POST",  /^\/api\/deliveries\/\d+\/reschedule$/,    [MANAGER, CLERK]],
  ["GET",   /^\/api\/deliveries\/\d+\/items$/,         [CASHIER, MANAGER, DRIVER, CLERK]],
  ["PATCH", /^\/api\/deliveries\/\d+\/status$/,        [DRIVER]],
  ["GET",   /^\/api\/delivery\/list$/,                 [DRIVER]],
  ["GET",   /^\/api\/delivery\/summary$/,              [DRIVER]],
  ["POST",  /^\/api\/delivery\/\d+\/claim$/,           [DRIVER]],
  ["POST",  /^\/api\/delivery\/\d+\/payment$/,         [DRIVER]],

  ["GET",   /^\/api\/inventory\/summary$/,             [CLERK, MANAGER]],
  ["GET",   /^\/api\/inventory\/products$/,            [CLERK, CASHIER, MANAGER]],
  ["GET",   /^\/api\/inventory\/products\/\d+\/units$/,       [CLERK, CASHIER, MANAGER]],
  ["POST",  /^\/api\/inventory\/products\/\d+\/units$/,       [CLERK]],
  ["DELETE", /^\/api\/inventory\/products\/\d+\/units\/\d+$/, [CLERK]],
  ["PUT",   /^\/api\/inventory\/products\/\d+\/pack$/,        [CLERK]],
  ["PUT",   /^\/api\/inventory\/products\/\d+\/description$/, [CLERK]],
  ["GET",   /^\/api\/inventory\/adjustments$/,         [CLERK]],
  ["POST",  /^\/api\/inventory\/adjust$/,              [CLERK]],

  ["POST",  /^\/api\/suppliers$/,                     [MANAGER]],
  ["PUT",   /^\/api\/suppliers\/\d+$/,                 [MANAGER]],
  ["PUT",   /^\/api\/customers\/\d+$/,                 [CASHIER]],
  ["POST",  /^\/api\/categories$/,                    [CLERK]],
  ["POST",  /^\/api\/units$/,                         [CLERK]],
  ["PUT",   /^\/api\/units\/\d+$/,                     [CLERK]],

  ["GET",   /^\/api\/purchase-orders$/,                [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/items$/,    [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/document$/, [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/reports$/,  [CLERK, MANAGER]],
  ["GET",   /^\/api\/purchase-orders\/\d+\/reference$/, [CLERK]],
  ["POST",  /^\/api\/purchase-orders$/,                [CLERK]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/decide$/,   [MANAGER]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/receive$/,  [CLERK]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/send$/,     [CLERK]],
  ["POST",  /^\/api\/purchase-orders\/\d+\/mark-sent$/, [CLERK]],
  ["GET",   /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}$/,          PUBLIC],
  ["GET",   /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}\/pdf$/,     PUBLIC],
  ["POST",  /^\/api\/supplier-order\/[A-Za-z0-9_-]{43}\/respond$/, PUBLIC],

  ["POST",  /^\/api\/materials$/,                      [CLERK]],

  ["GET",   /^\/api\/returns$/,                        [CLERK, CASHIER]],
  ["POST",  /^\/api\/returns$/,                        [CLERK, DRIVER]],
  ["POST",  /^\/api\/returns\/batch$/,                 [CLERK]],
  ["POST",  /^\/api\/refunds$/,                        [CASHIER]],
  ["POST",  /^\/api\/returns\/\d+\/resolve$/,          [CLERK]],

  ["GET",   /^\/api\/credit\/customers$/,              [MANAGER, CASHIER]],
  ["GET",   /^\/api\/credit\/customers\/\d+$/,         [MANAGER, CASHIER]],
  ["GET",   /^\/api\/credit\/open-sales$/,             [MANAGER, CASHIER]],
  ["PUT",   /^\/api\/credit\/customers\/\d+\/limit$/,  [MANAGER]],
  ["GET",   /^\/api\/credit\/policy$/,                 [MANAGER, CASHIER]],
  ["PUT",   /^\/api\/credit\/policy$/,                 [MANAGER]],
  ["GET",   /^\/api\/credit\/terms\/\d+$/,              [MANAGER, CASHIER]],
  ["GET",   /^\/api\/credit\/card\/\d+$/,               [MANAGER, CASHIER]],
  ["GET",   /^\/api\/policies$/,                         [MANAGER]],
  ["PUT",   /^\/api\/policies\/(credit|data-terms|refund|discount)$/, [MANAGER]],
  ["GET",   /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests$/,               [MANAGER, CASHIER]],
  ["POST",  /^\/api\/credit\/requests\/\d+\/decide$/,  [MANAGER]],
  ["GET",   /^\/api\/customers\/\d+\/history$/,        [MANAGER, CASHIER]],
  ["GET",   /^\/api\/customers\/\d+\/loyalty$/,        [MANAGER, CASHIER]],
  ["GET",   /^\/api\/loyalty\/policy$/,                [MANAGER]],
  ["PUT",   /^\/api\/loyalty\/policy$/,                [MANAGER]],

  ["POST",  /^\/api\/customers$/,                      [MANAGER, CASHIER]],
  ["POST",  /^\/api\/customers\/\d+\/portal-password$/, [CASHIER]],

  ["GET",   /^\/api\/records\/\w+$/,                   [MANAGER, CASHIER, CLERK]],
  ["GET",   /^\/api\/archives$/,                       MANAGEMENT],
  ["POST",  /^\/api\/archives\/archive$/,              [CLERK, ADMIN, MANAGER]],
  ["POST",  /^\/api\/archives\/restore$/,              [CLERK, ADMIN, MANAGER]],

  ["GET",   /^\/api\/store-settings$/,                 SIGNED_IN],
  ["PUT",   /^\/api\/store-settings$/,                 [ADMIN]],

  ["GET",   /^\/api\/notifications$/,                  SIGNED_IN],
  ["POST",  /^\/api\/notifications\/\d+\/read$/,       SIGNED_IN],
  ["POST",  /^\/api\/notifications\/read-all$/,        SIGNED_IN]
];

const CHANGES_NOTHING = [
  /^\/api\/users\/draft$/,
  /^\/api\/users\/\d+\/account\/draft$/
];

function requireRole(roles) {
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
    next();
  };
}

function notOwnAccount(request, response, next) {
  if (request.actor && Number(request.params.staffId) === Number(request.actor.staffId)) {
    return response.status(403).json({
      error: "You cannot change your own account from here. " +
             "Ask another administrator to make this change."
    });
  }
  next();
}

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

async function accessHook(request, response, next) {
  const lower = request.path.toLowerCase();
  if (lower.startsWith("/api/") && !request.path.startsWith("/api/")) return response.status(404).json({ error: "Not found" });
  if (!lower.startsWith("/api/")) return next();

  const allowed = findRule(request.method, request.path);

  if (allowed === null) {
    return response.status(403).json({ error: "This feature is not available." });
  }

  const isWrite = request.method !== "GET" && request.method !== "HEAD";
  const isSignIn = request.path === "/api/login" || request.path === "/api/logout" ||
                   request.path === "/api/heartbeat" ||
                   request.path === "/api/portal/login" || request.path === "/api/portal/logout" ||
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
    return response.status(401).json({
      error: state.endedReason || "Your session has ended. Please sign in again.",
      signedOut: true,
      ended: Boolean(state.endedReason)
    });
  }

  const byRole = allowed === SIGNED_IN || allowed.includes(session.roleName);

  let covering = [];
  if (session.roleName !== ADMIN) {
    covering = featuresCovering(request.method, request.path);
  }
  if (covering.length > 0) {
    let held;
    try {
      held = await heldFeatures(session.roleName);
    } catch (error) {
      held = { held: {}, granted: {} };
    }

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
