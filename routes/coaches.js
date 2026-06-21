const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const stripe = require('../stripeClient');
const { createUploadUrl } = require('../s3');
const { requireAuth, requireRole } = require('../middleware/auth');

/**
 * GET /api/coaches
 * Public search endpoint — only returns approved coaches.
 * Query params: region, car, specialty, maxRate
 */
router.get('/', async (req, res) => {
  const { region, car, specialty, maxRate } = req.query;
  const conditions = [`status = 'approved'`];
  const params = [];

  if (region) {
    params.push(region);
    conditions.push(`region_key = $${params.length}`);
  }
  if (car) {
    params.push(car);
    conditions.push(`$${params.length} = ANY(cartype)`);
  }
  if (specialty) {
    params.push(specialty);
    conditions.push(`$${params.length} = ANY(specialty)`);
  }
  if (maxRate) {
    params.push(Number(maxRate));
    conditions.push(`rate <= $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT id, name, bio, region_key, rate, cartype, specialty, rating
     FROM coach_profiles WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    params
  );
  res.json(rows);
});

/**
 * POST /api/coaches
 * A logged-in user applies to become a coach. Creates a 'pending' profile.
 * Body: { name: {en,zh,ja}, bio: {en,zh,ja}, regionKey, rate, cartype, specialty, contactEmail }
 */
router.post('/', requireAuth, async (req, res) => {
  const { name, bio, regionKey, rate, cartype, specialty, contactEmail } = req.body;

  if (!name || !bio || !regionKey || !rate || !cartype?.length || !specialty?.length || !contactEmail) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { rows } = await pool.query(
    `INSERT INTO coach_profiles
       (user_id, name, bio, region_key, rate, cartype, specialty, contact_email, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     RETURNING id`,
    [req.user.id, name, bio, regionKey, rate, cartype, specialty, contactEmail]
  );

  res.status(201).json({ coachId: rows[0].id });
});

/**
 * POST /api/coaches/:id/licence-upload-url
 * Returns a presigned S3 URL the browser uploads the licence file to directly.
 * Body: { contentType }
 */
router.post('/:id/licence-upload-url', requireAuth, async (req, res) => {
  const coachId = req.params.id;
  const { contentType, originalName } = req.body;

  // Confirm this coach profile belongs to the requesting user.
  const { rows } = await pool.query(
    `SELECT user_id FROM coach_profiles WHERE id = $1`, [coachId]
  );
  if (!rows.length || rows[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { url, key } = await createUploadUrl(coachId, contentType);

  await pool.query(
    `INSERT INTO licence_documents (coach_id, s3_key, content_type, original_name, review_status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [coachId, key, contentType, originalName || null]
  );

  res.json({ uploadUrl: url });
});

/**
 * POST /api/coaches/:id/stripe-onboarding
 * Creates (or reuses) a Stripe Connect Express account for the coach
 * and returns an onboarding link the frontend should redirect the coach to.
 */
router.post('/:id/stripe-onboarding', requireAuth, async (req, res) => {
  const coachId = req.params.id;

  const { rows } = await pool.query(
    `SELECT user_id, stripe_account_id, contact_email FROM coach_profiles WHERE id = $1`,
    [coachId]
  );
  if (!rows.length || rows[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  let accountId = rows[0].stripe_account_id;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'JP',
      email: rows[0].contact_email,
      capabilities: {
        transfers: { requested: true },
      },
    });
    accountId = account.id;
    await pool.query(
      `UPDATE coach_profiles SET stripe_account_id = $1 WHERE id = $2`,
      [accountId, coachId]
    );
  }

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: process.env.CONNECT_REFRESH_URL,
    return_url: process.env.CONNECT_RETURN_URL,
    type: 'account_onboarding',
  });

  res.json({ url: accountLink.url });
});

module.exports = router;
