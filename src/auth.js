const xsenv = require('@sap/xsenv');
const xssec = require('@sap/xssec');

function initAuth(app, passport) {
  // In CF, xsenv.getServices(...) resolves bound XSUAA.
  // Locally, you can point VCAP_SERVICES to a file or env var.
  xsenv.loadEnv();

  let services = {};
  try {
    services = xsenv.getServices({ uaa: { tag: 'xsuaa' } });
  } catch (_e) {
    // No bound services (local dev) -> allow app to start; protected endpoints will fail auth.
    services = {};
  }

  if (services.uaa) {
    passport.use(new xssec.JWTStrategy(services.uaa));
  }

  app.use(passport.initialize());
}

function requireJwt(passport) {
  return (req, res, next) => {
    if (!passport._strategy('JWT')) {
      return res.status(500).json({
        error: 'auth_not_configured',
        message: 'XSUAA not bound/configured; cannot validate JWT'
      });
    }
    return passport.authenticate('JWT', { session: false })(req, res, next);
  };
}

function requireScope(scopeName) {
  return (req, res, next) => {
    const authInfo = req.authInfo;
    if (!authInfo || typeof authInfo.checkScope !== 'function') {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing JWT auth info' });
    }
    if (!authInfo.checkScope(scopeName)) {
      return res.status(403).json({ error: 'forbidden', message: `Missing scope ${scopeName}` });
    }
    return next();
  };
}

module.exports = { initAuth, requireJwt, requireScope };

