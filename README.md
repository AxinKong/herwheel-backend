# HerWheel backend (starter)

Minimal Express + PostgreSQL + Stripe Connect backend for the HerWheel platform.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
psql $DATABASE_URL -f db/schema.sql
npm run dev
```

In a second terminal, forward Stripe webhooks to your local server:

```bash
npm run stripe:listen
```

This prints a `whsec_...` value — put it in `.env` as `STRIPE_WEBHOOK_SECRET`.

## Auth

- `POST /api/auth/register` — { email, password, lang } → { token, user }
  Also sends a "registration successful" welcome email (via Resend) to
  the user's address, in their selected language. The email confirms
  the account email/username but never includes the password — only a
  reminder to keep the chosen password safe.
- `POST /api/auth/login` — { email, password } → { token, user }

Send the token as `Authorization: Bearer <token>` on subsequent requests.
`role` is `learner` by default. To make a user an admin (for the review
dashboard), update it directly in the database:
`UPDATE users SET role = 'admin' WHERE email = '...';`

## Coaches — `/api/coaches`

- `GET /api/coaches?region=tokyo&car=auto&specialty=highway&maxRate=5000`
  Public search. Only returns `status = 'approved'` profiles.

- `POST /api/coaches` (auth required)
  Submits a coach application with `status = 'pending'`.
  Body: `{ name: {en,zh,ja}, bio: {en,zh,ja}, regionKey, rate, cartype, specialty, contactEmail }`

- `POST /api/coaches/:id/licence-upload-url` (auth required, owner only)
  Returns a presigned S3 URL. The browser `PUT`s the licence file directly
  to S3 using this URL — the file never passes through your server.
  Body: `{ contentType, originalName }`

- `POST /api/coaches/:id/stripe-onboarding` (auth required, owner only)
  Creates a Stripe Connect Express account for the coach (if not already
  created) and returns a hosted onboarding link to redirect the coach to.
  The coach must complete this before they can receive payouts.

## Bookings — `/api/bookings`

- `POST /api/bookings` (auth required)
  Body: `{ coachId, amountJpy }`
  Creates a PaymentIntent that splits the payment: `PLATFORM_FEE_PERCENT`
  (default 15%) becomes your `application_fee_amount`, the rest transfers
  to the coach's connected account. Returns `{ bookingId, clientSecret }`.
  The frontend uses `clientSecret` with Stripe.js's Payment Element to
  collect card details.

- `GET /api/bookings/:id` (auth required, owner only)
  Poll booking status. Returns the coach's contact info only once
  `status === 'paid'`.

## Admin review — `/api/admin/review`

All routes require `role = 'admin'`.

- `GET /api/admin/review`
  Lists pending coach applications, each with a short-lived signed URL to
  view their uploaded licence document.

- `POST /api/admin/review/:coachId/approve`
  Sets the coach profile to `approved` (now visible in search) and marks
  the licence document reviewed.

- `POST /api/admin/review/:coachId/reject`
  Sets the coach profile to `rejected`.

## Stripe webhook — `/webhooks/stripe`

Handles:
- `payment_intent.succeeded` → marks the booking `paid`
- `payment_intent.payment_failed` → marks the booking `failed`
- `account.updated` → marks `stripe_onboarded = true` once a coach's
  Connect account can accept charges/payouts

## Notes / next steps

- Email: sign up at https://resend.com (free tier), get an API key, put
  it in `RESEND_API_KEY`. Without it, registration still works — the
  email send is skipped with a warning logged.
- This starter has no email sending — add a transactional email step in
  the webhook handler once a booking is marked `paid`.
- JPY is a zero-decimal currency in Stripe: `amountJpy` is the actual yen
  amount (e.g. `300` = ¥300), not multiplied by 100.
- Before going live, a coach must complete Stripe Connect onboarding
  (`stripe_onboarded = true`) — `POST /api/bookings` returns 409 if not.
- Licence documents are stored in S3 only, never in the database or
  localStorage — admins view them via short-lived signed URLs.
