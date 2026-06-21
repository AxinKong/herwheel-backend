const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const stripe = require('../stripeClient');

/**
 * POST /webhooks/stripe
 *
 * IMPORTANT: this route must receive the RAW request body for Stripe's
 * signature check to work. In server.js it's mounted with
 * express.raw({ type: 'application/json' }) — do NOT apply express.json()
 * globally before this route.
 */
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      await pool.query(
        `UPDATE bookings SET status = 'paid', paid_at = now()
         WHERE stripe_payment_intent_id = $1`,
        [pi.id]
      );
      // TODO: send confirmation emails to learner and coach here.
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      await pool.query(
        `UPDATE bookings SET status = 'failed'
         WHERE stripe_payment_intent_id = $1`,
        [pi.id]
      );
      break;
    }

    case 'account.updated': {
      // Fires as a coach completes Stripe Connect onboarding steps.
      const account = event.data.object;
      if (account.details_submitted && account.charges_enabled) {
        await pool.query(
          `UPDATE coach_profiles SET stripe_onboarded = true WHERE stripe_account_id = $1`,
          [account.id]
        );
      }
      break;
    }

    default:
      // Unhandled event types are fine to ignore.
      break;
  }

  res.json({ received: true });
});

module.exports = router;
