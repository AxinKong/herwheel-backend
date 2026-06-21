const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const stripe = require('../stripeClient');
const { requireAuth } = require('../middleware/auth');

const FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 15);

/**
 * POST /api/bookings
 * Creates a PaymentIntent for "unlocking" a coach's contact info.
 * Splits the payment: (100 - FEE_PERCENT)% goes to the coach's connected
 * account, FEE_PERCENT% stays on the platform as application_fee_amount.
 *
 * Body: { coachId, amountJpy }
 */
router.post('/', requireAuth, async (req, res) => {
  const { coachId, amountJpy } = req.body;

  if (!coachId || !amountJpy || amountJpy <= 0) {
    return res.status(400).json({ error: 'coachId and amountJpy are required' });
  }

  const { rows } = await pool.query(
    `SELECT id, stripe_account_id, status FROM coach_profiles WHERE id = $1`,
    [coachId]
  );
  const coach = rows[0];

  if (!coach || coach.status !== 'approved') {
    return res.status(404).json({ error: 'Coach not found or not approved' });
  }
  if (!coach.stripe_account_id) {
    return res.status(409).json({ error: 'Coach has not completed payout setup yet' });
  }

  // JPY is a zero-decimal currency in Stripe: amountJpy IS the yen amount.
  const platformFee = Math.round(amountJpy * (FEE_PERCENT / 100));

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountJpy,
    currency: 'jpy',
    payment_method_types: ['card'],
    application_fee_amount: platformFee,
    transfer_data: {
      destination: coach.stripe_account_id,
    },
    metadata: {
      coach_id: String(coachId),
      learner_id: String(req.user.id),
    },
  });

  const { rows: bookingRows } = await pool.query(
    `INSERT INTO bookings
       (learner_id, coach_id, amount_jpy, platform_fee_jpy, stripe_payment_intent_id, status)
     VALUES ($1, $2, $3, $4, $5, 'created')
     RETURNING id`,
    [req.user.id, coachId, amountJpy, platformFee, paymentIntent.id]
  );

  res.json({
    bookingId: bookingRows[0].id,
    clientSecret: paymentIntent.client_secret,
  });
});

/**
 * GET /api/bookings/:id
 * Lets the learner poll booking status (used after redirect from Stripe,
 * as a fallback to the webhook for showing "payment confirmed" in the UI).
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.amount_jpy, b.platform_fee_jpy, b.paid_at,
            c.contact_email, c.name
     FROM bookings b
     JOIN coach_profiles c ON c.id = b.coach_id
     WHERE b.id = $1 AND b.learner_id = $2`,
    [req.params.id, req.user.id]
  );

  if (!rows.length) return res.status(404).json({ error: 'Not found' });

  const booking = rows[0];
  res.json({
    id: booking.id,
    status: booking.status,
    amountJpy: booking.amount_jpy,
    platformFeeJpy: booking.platform_fee_jpy,
    paidAt: booking.paid_at,
    // Only reveal contact info once payment has succeeded.
    coachContact: booking.status === 'paid' ? booking.contact_email : null,
    coachName: booking.status === 'paid' ? booking.name : null,
  });
});

module.exports = router;
