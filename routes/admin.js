const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { createViewUrl } = require('../s3');
const { requireAuth, requireRole } = require('../middleware/auth');

// All routes here require an authenticated admin.
router.use(requireAuth, requireRole('admin'));

/**
 * GET /api/admin/review
 * Lists coach profiles awaiting review, with a signed URL to view their
 * licence document(s).
 */
router.get('/', async (req, res) => {
  const { rows: coaches } = await pool.query(
    `SELECT id, name, bio, region_key, rate, cartype, specialty, contact_email, created_at
     FROM coach_profiles WHERE status = 'pending' ORDER BY created_at ASC`
  );

  const results = [];
  for (const coach of coaches) {
    const { rows: docs } = await pool.query(
      `SELECT id, s3_key, content_type, original_name, review_status
       FROM licence_documents WHERE coach_id = $1 ORDER BY uploaded_at DESC LIMIT 1`,
      [coach.id]
    );

    let licence = null;
    if (docs.length) {
      const viewUrl = await createViewUrl(docs[0].s3_key);
      licence = {
        id: docs[0].id,
        viewUrl,
        contentType: docs[0].content_type,
        originalName: docs[0].original_name,
        reviewStatus: docs[0].review_status,
      };
    }

    results.push({ ...coach, licence });
  }

  res.json(results);
});

/**
 * POST /api/admin/review/:coachId/approve
 * Approves the coach profile (and its licence doc) so it appears in search.
 */
router.post('/:coachId/approve', async (req, res) => {
  const { coachId } = req.params;

  await pool.query(`UPDATE coach_profiles SET status = 'approved' WHERE id = $1`, [coachId]);
  await pool.query(
    `UPDATE licence_documents SET review_status = 'approved', reviewed_by = $1, reviewed_at = now()
     WHERE coach_id = $2`,
    [req.user.id, coachId]
  );

  res.json({ ok: true });
});

/**
 * POST /api/admin/review/:coachId/reject
 * Rejects the application. Body may include { reason } for an internal note.
 */
router.post('/:coachId/reject', async (req, res) => {
  const { coachId } = req.params;

  await pool.query(`UPDATE coach_profiles SET status = 'rejected' WHERE id = $1`, [coachId]);
  await pool.query(
    `UPDATE licence_documents SET review_status = 'rejected', reviewed_by = $1, reviewed_at = now()
     WHERE coach_id = $2`,
    [req.user.id, coachId]
  );

  res.json({ ok: true });
});

module.exports = router;
