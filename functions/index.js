const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const fetch     = require('node-fetch');

admin.initializeApp();

// ── Lazy helpers (secrets only available at request time in 1st-gen) ─────────
function getStripe(){
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

const EV_TOKEN_URL    = 'https://apicenter.eagleview.com/oauth2/v1/token';
const EV_API_BASE     = 'https://apicenter.eagleview.com';
const STRIPE_PRICE_ID = 'price_1TS72mIC3L4eL1eQQ6WlyMkv';
const APP_URL         = 'https://dmays1989.github.io/Ridgeline-CRM';

// ── Helper: billing ref ──────────────────────────────────────────────────────
function billingRef(companyCode) {
  return admin.firestore()
    .collection('companies').doc(companyCode)
    .collection('settings').doc('billing');
}

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

// ── Callable: evProxy ────────────────────────────────────────────────────────
// EV credentials are stored in ridgelineConfig/eagleview (platform-level, not per-company)
exports.evProxy = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  }

  const { action, companyCode, params = {} } = data;
  if (!companyCode) {
    throw new functions.https.HttpsError('invalid-argument', 'companyCode required');
  }

  // Load Ridgeline's master EV credentials — not tied to any company
  const evConfigSnap = await admin.firestore()
    .collection('ridgelineConfig').doc('eagleview')
    .get();

  if (!evConfigSnap.exists) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'EagleView not configured — contact Ridgeline support'
    );
  }

  const evConfig     = evConfigSnap.data();
  const clientId     = evConfig.clientId;
  const clientSecret = evConfig.clientSecret;

  if (!clientId || !clientSecret) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'EagleView credentials incomplete — contact Ridgeline support'
    );
  }

  let token;
  try {
    token = await getEvToken(clientId, clientSecret);
  } catch (e) {
    throw new functions.https.HttpsError('internal', e.message);
  }

  let url, method = 'GET', body = null;

  switch (action) {
    case 'getProducts':
      url = EV_API_BASE + '/v2/Product/GetAvailableProducts';
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

  return await apiRes.json();
});

// ── Callable: createCheckoutSession ─────────────────────────────────────────
exports.createCheckoutSession = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  }

  const { companyCode } = data;
  if (!companyCode) {
    throw new functions.https.HttpsError('invalid-argument', 'companyCode required');
  }

  const stripe = getStripe();
  const bRef   = billingRef(companyCode);
  const bSnap  = await bRef.get();
  const billing = bSnap.exists ? bSnap.data() : {};

  // Get or create Stripe customer
  let customerId = billing.stripeCustomerId;
  if (!customerId) {
    const profileSnap = await admin.firestore()
      .collection('companies').doc(companyCode)
      .collection('settings').doc('companyProfile')
      .get();
    const profile = profileSnap.exists ? profileSnap.data() : {};

    let customer;
    try {
      customer = await stripe.customers.create({
        email:    profile.email || context.auth.token.email || '',
        name:     profile.name  || companyCode,
        metadata: { companyCode, firebaseUid: context.auth.uid }
      });
    } catch (e) {
      console.error('Stripe customer create failed:', e);
      throw new functions.https.HttpsError('internal', 'Stripe error: ' + e.message);
    }
    customerId = customer.id;

    await bRef.set({ stripeCustomerId: customerId }, { merge: true });
    await admin.firestore()
      .collection('stripeCustomers').doc(customerId)
      .set({ companyCode });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ['card'],
      mode:                 'subscription',
      line_items:           [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url:          APP_URL + '/?billing=success',
      cancel_url:           APP_URL + '/?billing=cancelled',
      metadata:             { companyCode }
    });
  } catch (e) {
    console.error('Stripe checkout session failed:', e);
    throw new functions.https.HttpsError('internal', 'Stripe error: ' + e.message);
  }

  return { url: session.url };
});

// ── Callable: createPortalSession ────────────────────────────────────────────
exports.createPortalSession = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  }

  const { companyCode } = data;
  const stripe = getStripe();
  const bSnap  = await billingRef(companyCode).get();
  if (!bSnap.exists || !bSnap.data().stripeCustomerId) {
    throw new functions.https.HttpsError('not-found', 'No billing account found');
  }

  let session;
  try {
    session = await stripe.billingPortal.sessions.create({
      customer:   bSnap.data().stripeCustomerId,
      return_url: APP_URL
    });
  } catch (e) {
    console.error('Stripe portal session failed:', e);
    throw new functions.https.HttpsError('internal', 'Stripe error: ' + e.message);
  }

  return { url: session.url };
});

// ── HTTP: stripeWebhook ──────────────────────────────────────────────────────
exports.stripeWebhook = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] })
  .https.onRequest(async (req, res) => {
  const stripe        = getStripe();
  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send('Webhook Error: ' + e.message);
  }

  async function getCompanyCode(customerId) {
    const snap = await admin.firestore()
      .collection('stripeCustomers').doc(customerId).get();
    return snap.exists ? snap.data().companyCode : null;
  }

  async function updateBilling(customerId, updates) {
    const companyCode = await getCompanyCode(customerId);
    if (!companyCode) { console.warn('No companyCode for customer', customerId); return; }
    await billingRef(companyCode).set(updates, { merge: true });
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode === 'subscription') {
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        await updateBilling(obj.customer, {
          subscriptionId:   sub.id,
          status:           sub.status,
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
          trialEnd:         sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null
        });
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      await updateBilling(obj.customer, {
        subscriptionId:   obj.id,
        status:           obj.status,
        currentPeriodEnd: new Date(obj.current_period_end * 1000).toISOString(),
        trialEnd:         obj.trial_end ? new Date(obj.trial_end * 1000).toISOString() : null
      });
      break;
    }
    case 'customer.subscription.deleted': {
      await updateBilling(obj.customer, { status: 'canceled', subscriptionId: obj.id });
      break;
    }
    case 'invoice.payment_failed': {
      await updateBilling(obj.customer, { status: 'past_due' });
      break;
    }
    case 'invoice.payment_succeeded': {
      if (obj.subscription) {
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        await updateBilling(obj.customer, {
          status:           sub.status,
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString()
        });
      }
      break;
    }
  }

  res.json({ received: true });
});
