const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const stripe = require('../stripeClient');
const { requireAuth } = require('../middleware/auth');
const { sendBookingNotificationEmail, sendBookingConfirmedEmail } = require('../email');

const FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 15);

/**
 * POST /api/bookings
 * Authorises (but does NOT capture) a card for a session booking.
 * Capture happens later when the coach confirms (PUT /:id/confirm).
 * Body: { coachId, bookingDate, startHour, endHour }
 */
router.post('/', requireAuth, async (req, res) => {
  const { coachId, bookingDate, startHour, endHour } = req.body;

  if (!coachId || !bookingDate || startHour == null || endHour == null) {
    return res.status(400).json({ error: 'coachId, bookingDate, startHour, endHour are required' });
  }
  if (endHour - startHour < 2) {
    return res.status(400).json({ error: 'Minimum booking is 2 hours' });
  }

  const { rows } = await pool.query(
    `SELECT id, stripe_account_id, rate, status, contact_email, name FROM coach_profiles WHERE id = $1`,
    [coachId]
  );
  const coach = rows[0];
  if (!coach || coach.status !== 'approved') {
    return res.status(404).json({ error: 'Coach not found or not approved' });
  }

  const hours = endHour - startHour;
  const amountJpy = hours * coach.rate;
  const platformFee = Math.round(amountJpy * (FEE_PERCENT / 100));

  const intentParams = {
    amount: amountJpy,
    currency: 'jpy',
    // Let Stripe show all payment methods enabled in the dashboard
    // (card, PayPay, Alipay, etc.). redirect-based methods like PayPay/Alipay
    // charge immediately; card payments also charge immediately for consistency.
    automatic_payment_methods: { enabled: true },
    metadata: {
      coach_id: String(coachId),
      learner_id: String(req.user.id),
      booking_date: bookingDate,
      start_hour: String(startHour),
      end_hour: String(endHour),
    },
  };

  if (coach.stripe_account_id) {
    intentParams.application_fee_amount = platformFee;
    intentParams.transfer_data = { destination: coach.stripe_account_id };
  }

  const paymentIntent = await stripe.paymentIntents.create(intentParams);

  const { rows: bookingRows } = await pool.query(
    `INSERT INTO bookings
       (learner_id, coach_id, amount_jpy, platform_fee_jpy,
        stripe_payment_intent_id, status,
        booking_date, start_hour, end_hour, hours)
     VALUES ($1,$2,$3,$4,$5,'authorized',$6,$7,$8,$9)
     RETURNING id`,
    [req.user.id, coachId, amountJpy, platformFee,
     paymentIntent.id, bookingDate, startHour, endHour, hours]
  );

  const bookingId = bookingRows[0].id;

  // Fire-and-forget: notify the coach by email (errors are logged, not thrown)
  const coachName = typeof coach.name === 'object' ? (coach.name.en || coach.name.ja || '') : coach.name;
  sendBookingNotificationEmail({
    coachEmail: coach.contact_email,
    coachName,
    learnerEmail: req.user.email,
    bookingDate,
    startHour,
    endHour,
    hours,
    amountJpy,
    bookingId,
  });

  res.json({
    bookingId,
    clientSecret: paymentIntent.client_secret,
    amountJpy,
  });
});

/**
 * GET /api/bookings
 * Returns all bookings for the current learner.
 */
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.amount_jpy, b.hours,
            b.booking_date, b.start_hour, b.end_hour,
            b.created_at, b.confirmed_at, b.cancelled_at,
            b.stripe_payment_intent_id,
            c.name AS coach_name, c.rate AS coach_rate, c.region_key
     FROM bookings b
     JOIN coach_profiles c ON c.id = b.coach_id
     WHERE b.learner_id = $1
     ORDER BY b.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

/**
 * GET /api/bookings/coach/incoming
 * Returns all bookings for the coach profile owned by the current user.
 */
router.get('/coach/incoming', requireAuth, async (req, res) => {
  // Find the coach profile belonging to this user
  const { rows: profiles } = await pool.query(
    `SELECT id FROM coach_profiles WHERE user_id = $1 AND status = 'approved'`,
    [req.user.id]
  );
  if (!profiles.length) return res.status(404).json({ error: 'No approved coach profile found' });
  const coachId = profiles[0].id;

  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.amount_jpy, b.hours,
            b.booking_date, b.start_hour, b.end_hour, b.created_at,
            u.email AS learner_email
     FROM bookings b
     JOIN users u ON u.id = b.learner_id
     WHERE b.coach_id = $1
     ORDER BY b.booking_date ASC, b.start_hour ASC`,
    [coachId]
  );
  res.json(rows);
});

/**
 * GET /api/bookings/:id
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.amount_jpy, b.hours,
            b.booking_date, b.start_hour, b.end_hour, b.created_at,
            c.name AS coach_name, c.contact_email, c.rate
     FROM bookings b
     JOIN coach_profiles c ON c.id = b.coach_id
     WHERE b.id = $1 AND b.learner_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

/**
 * PUT /api/bookings/:id/confirm
 * Coach confirms the booking.
 * - If PI is `requires_capture` (manual hold): capture it now.
 * - If PI is already `succeeded` (auto-captured): just update the DB.
 */
router.put('/:id/confirm', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.stripe_payment_intent_id, b.status, b.amount_jpy, b.hours,
              b.booking_date, b.start_hour, b.end_hour,
              c.user_id, c.name AS coach_name,
              u.email AS learner_email
       FROM bookings b
       JOIN coach_profiles c ON c.id = b.coach_id
       JOIN users u ON u.id = b.learner_id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const booking = rows[0];

    if (booking.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (booking.status !== 'authorized') {
      return res.status(409).json({ error: `Cannot confirm booking in status: ${booking.status}` });
    }

    // Only capture if the PI still needs it (manual hold); skip if already succeeded
    const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
    if (pi.status === 'requires_capture') {
      await stripe.paymentIntents.capture(booking.stripe_payment_intent_id);
    }
    // If pi.status === 'succeeded', payment already captured — just confirm in DB

    await pool.query(
      `UPDATE bookings SET status='confirmed', confirmed_at=NOW() WHERE id=$1`,
      [req.params.id]
    );

    const coachName = typeof booking.coach_name === 'object'
      ? (booking.coach_name.en || booking.coach_name.ja || '')
      : booking.coach_name;
    sendBookingConfirmedEmail({
      learnerEmail: booking.learner_email,
      coachName,
      bookingDate: booking.booking_date,
      startHour: booking.start_hour,
      endHour: booking.end_hour,
      hours: booking.hours,
      amountJpy: booking.amount_jpy,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Confirm booking error:', err);
    res.status(500).json({ error: err.message || 'Failed to confirm booking' });
  }
});

/**
 * PUT /api/bookings/:id/cancel
 * Learner or coach cancels.
 * - PI in requires_payment_method / requires_capture → cancel PI
 * - PI already succeeded → issue full refund
 */
router.put('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.stripe_payment_intent_id, b.status, b.learner_id, c.user_id AS coach_user_id
       FROM bookings b JOIN coach_profiles c ON c.id = b.coach_id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const booking = rows[0];

    // Allow either the learner or the coach to cancel
    if (booking.learner_id !== req.user.id && booking.coach_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!['authorized', 'confirmed'].includes(booking.status)) {
      return res.status(409).json({ error: `Cannot cancel booking in status: ${booking.status}` });
    }

    const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
    if (pi.status === 'succeeded') {
      // Payment already captured — refund in full
      await stripe.refunds.create({ payment_intent: booking.stripe_payment_intent_id });
    } else if (!['canceled', 'requires_payment_method'].includes(pi.status)) {
      await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);
    }

    await pool.query(
      `UPDATE bookings SET status='cancelled', cancelled_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Cancel booking error:', err);
    res.status(500).json({ error: err.message || 'Failed to cancel booking' });
  }
});

/**
 * PUT /api/bookings/:id/reschedule
 * Learner reschedules → cancel old PI, create new booking row.
 * Body: { bookingDate, startHour, endHour }
 */
router.put('/:id/reschedule', requireAuth, async (req, res) => {
  const { bookingDate, startHour, endHour } = req.body;
  if (!bookingDate || startHour == null || endHour == null || endHour - startHour < 2) {
    return res.status(400).json({ error: 'Valid bookingDate, startHour, endHour required (min 2h)' });
  }

  const { rows } = await pool.query(
    `SELECT b.*, c.rate, c.stripe_account_id
     FROM bookings b JOIN coach_profiles c ON c.id = b.coach_id
     WHERE b.id=$1 AND b.learner_id=$2`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const old = rows[0];

  if (!['authorized'].includes(old.status)) {
    return res.status(409).json({ error: 'Can only reschedule authorized bookings' });
  }

  // Cancel old authorisation
  try { await stripe.paymentIntents.cancel(old.stripe_payment_intent_id); } catch (_) {}
  await pool.query(`UPDATE bookings SET status='cancelled', cancelled_at=NOW() WHERE id=$1`, [req.params.id]);

  // Create new booking (reuse POST logic)
  const hours = endHour - startHour;
  const amountJpy = hours * old.rate;
  const platformFee = Math.round(amountJpy * (FEE_PERCENT / 100));

  const intentParams = {
    amount: amountJpy, currency: 'jpy',
    automatic_payment_methods: { enabled: true },
    metadata: { coach_id: String(old.coach_id), learner_id: String(req.user.id) },
  };
  if (old.stripe_account_id) {
    intentParams.application_fee_amount = platformFee;
    intentParams.transfer_data = { destination: old.stripe_account_id };
  }

  const pi = await stripe.paymentIntents.create(intentParams);
  const { rows: newRows } = await pool.query(
    `INSERT INTO bookings
       (learner_id, coach_id, amount_jpy, platform_fee_jpy,
        stripe_payment_intent_id, status, booking_date, start_hour, end_hour, hours)
     VALUES ($1,$2,$3,$4,$5,'authorized',$6,$7,$8,$9) RETURNING id`,
    [req.user.id, old.coach_id, amountJpy, platformFee,
     pi.id, bookingDate, startHour, endHour, hours]
  );

  res.json({ bookingId: newRows[0].id, clientSecret: pi.client_secret, amountJpy });
});

module.exports = router;
