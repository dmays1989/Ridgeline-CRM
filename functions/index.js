const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const fetch     = require('node-fetch');

admin.initializeApp();

const EV_TOKEN_URL  = 'https://apicenter.eagleview.com/oauth2/v1/token';
// Switch to 'https://apicenter.eagleview.com' for production
const EV_API_BASE   = 'https://sandbox.apicenter.eagleview.com';

// ── Helper: get EagleView bearer token ──────────────────────────────────────
async function getEvToken(clientId, clientSecret) {
  const creds = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const r = await fetch(EV_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('EagleView auth failed (' + r.status + '): ' + txt);
  }
  const d = await r.json();
  return d.access_token;
}

// ── Callable function: evProxy ───────────────────────────────────────────────
// Called from the app with { action, companyCode, params }
exports.evProxy = functions.https.onCall(async (data, context) => {
  // Must be signed in
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  }

  const { action, companyCode, params = {} } = data;
  if (!companyCode) {
    throw new functions.https.HttpsError('invalid-argument', 'companyCode required');
  }

  // Read EagleView credentials from Firestore (server-side only — never sent to browser)
  const profileSnap = await admin.firestore()
    .collection('companies').doc(companyCode)
    .collection('settings').doc('profile')
    .get();

  if (!profileSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Company profile not found');
  }

  const profile = profileSnap.data();
  const clientId     = profile.evClientId;
  const clientSecret = profile.evClientSecret;

  if (!clientId || !clientSecret) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'EagleView credentials not configured — add them in Settings → Company Profile'
    );
  }

  // Get EagleView token
  let token;
  try {
    token = await getEvToken(clientId, clientSecret);
  } catch (e) {
    throw new functions.https.HttpsError('internal', e.message);
  }

  // Route to the right endpoint
  let url, method = 'GET', body = null;

  switch (action) {

    case 'getProducts':
      url = EV_API_BASE + '/GetAvailableProducts';
      break;

    case 'placeOrder':
      url    = EV_API_BASE + '/v2/Order/PlaceOrder';
      method = 'POST';
      body   = JSON.stringify(params.orderBody);
      break;

    case 'getReport':
      url = EV_API_BASE + '/v3/Report/GetReport?reportId=' + params.reportId;
      break;

    default:
      throw new functions.https.HttpsError('invalid-argument', 'Unknown action: ' + action);
  }

  const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const apiRes  = await fetch(url, { method, headers, ...(body ? { body } : {}) });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    throw new functions.https.HttpsError('internal', 'EagleView ' + apiRes.status + ': ' + errText);
  }

  const result = await apiRes.json();
  return Array.isArray(result) ? result : result;
});
