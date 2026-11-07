import { query, withTransaction } from './db';
import { getDriverRatingPolicy, getAdminContacts } from './settings';
import { sendWhatsAppText } from './whatsapp';
import { PoolClient } from 'pg';

export interface RecordRatingInput {
  bookingId: number;
  rating: number; // 1 to 5
  feedbackCategory?: string;
  customerComment?: string;
}

export interface DriverRatingSummary {
  driverId: number;
  driverName: string;
  currentRating: number;
  totalTripsCompleted: number;
  totalRatingsCount: number;
  rating5Count: number;
  rating1Count: number;
  recentReviews: {
    id: number;
    bookingId: number;
    rating: number;
    feedbackCategory?: string;
    customerComment?: string;
    isDisputed: boolean;
    createdAt: string;
  }[];
}

/**
 * Record a customer's rating for a completed booking and atomically recalculate driver stats.
 */
export async function recordCustomerRating(input: RecordRatingInput): Promise<{
  success: boolean;
  newDriverRating: number;
  shouldPromptGoogleReview: boolean;
  googleReviewUrl: string;
  alertAdmin: boolean;
  message: string;
}> {
  const policy = await getDriverRatingPolicy();
  const normalizedRating = Math.max(1, Math.min(5, Math.round(input.rating)));

  return withTransaction(async (client: PoolClient) => {
    // 1. Fetch booking & driver info
    const bRes = await client.query(
      `SELECT id, assigned_driver_id, customer_id, booking_code, booking_status 
       FROM crm_bookings 
       WHERE id = $1 FOR UPDATE`,
      [input.bookingId]
    );

    if (bRes.rows.length === 0) {
      throw new Error(`Booking #${input.bookingId} not found.`);
    }

    const booking = bRes.rows[0];
    const driverId = booking.assigned_driver_id;

    if (!driverId) {
      throw new Error(`No driver assigned to booking #${input.bookingId}.`);
    }

    // 2. Check if a rating already exists for this booking (Idempotency)
    const existingRatingRes = await client.query(
      `SELECT id, rating FROM crm_driver_ratings WHERE booking_id = $1`,
      [input.bookingId]
    );

    let ratingRecordId: number;
    if (existingRatingRes.rows.length > 0) {
      // Update existing rating (e.g. customer subsequently selected a feedback category or revised score)
      const updateRes = await client.query(
        `UPDATE crm_driver_ratings
         SET rating = $1,
             feedback_category = COALESCE($2, feedback_category),
             customer_comment = COALESCE($3, customer_comment),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING id`,
        [normalizedRating, input.feedbackCategory || null, input.customerComment || null, existingRatingRes.rows[0].id]
      );
      ratingRecordId = updateRes.rows[0].id;
    } else {
      // Insert new rating
      const insertRes = await client.query(
        `INSERT INTO crm_driver_ratings
         (booking_id, driver_id, customer_id, rating, feedback_category, customer_comment)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          input.bookingId,
          driverId,
          booking.customer_id,
          normalizedRating,
          input.feedbackCategory || null,
          input.customerComment || null,
        ]
      );
      ratingRecordId = insertRes.rows[0].id;
    }

    // 3. Atomically recalculate driver's ratings (excluding disputed ratings)
    const statsRes = await client.query(
      `SELECT 
         COUNT(*) AS total_ratings,
         COALESCE(AVG(rating), $2) AS avg_rating,
         COUNT(*) FILTER (WHERE rating = 5) AS count_5,
         COUNT(*) FILTER (WHERE rating = 1) AS count_1
       FROM crm_driver_ratings
       WHERE driver_id = $1 AND is_disputed = false`,
      [driverId, policy.default_initial_rating]
    );

    const stats = statsRes.rows[0];
    const calculatedRating = parseFloat(Number(stats.avg_rating).toFixed(2));
    const totalRatings = parseInt(stats.total_ratings, 10);
    const count5 = parseInt(stats.count_5, 10);
    const count1 = parseInt(stats.count_1, 10);

    // 4. Quality guardrails: Check consecutive 1-star ratings
    const recentRatingsRes = await client.query(
      `SELECT rating FROM crm_driver_ratings
       WHERE driver_id = $1 AND is_disputed = false
       ORDER BY created_at DESC
       LIMIT $2`,
      [driverId, policy.auto_suspend_consecutive_1_stars]
    );

    const consecutive1Stars =
      recentRatingsRes.rows.length >= policy.auto_suspend_consecutive_1_stars &&
      recentRatingsRes.rows.every((r) => r.rating === 1);

    const isCritical = calculatedRating < policy.critical_alert_threshold;
    let newOnboardingStatus: string | null = null;

    if (consecutive1Stars) {
      newOnboardingStatus = 'SUSPENDED_QUALITY';
    }

    // 5. Update crm_drivers row
    if (newOnboardingStatus) {
      await client.query(
        `UPDATE crm_drivers
         SET rating = $1,
             total_ratings_count = $2,
             rating_5_count = $3,
             rating_1_count = $4,
             onboarding_status = $5,
             is_available = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $6`,
        [calculatedRating, totalRatings, count5, count1, newOnboardingStatus, driverId]
      );
    } else {
      await client.query(
        `UPDATE crm_drivers
         SET rating = $1,
             total_ratings_count = $2,
             rating_5_count = $3,
             rating_1_count = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [calculatedRating, totalRatings, count5, count1, driverId]
      );
    }

    const alertAdmin = isCritical || consecutive1Stars || normalizedRating === 1;

    // Send WhatsApp notification to Admin if critical or low rating
    if (alertAdmin) {
      const admins = await getAdminContacts();
      const driverRes = await client.query(`SELECT full_name, phone FROM crm_drivers WHERE id = $1`, [driverId]);
      const driverName = driverRes.rows[0]?.full_name || `Driver #${driverId}`;

      for (const admin of admins) {
        if (admin.phone) {
          await sendWhatsAppText(
            admin.phone,
            `⚠️ Driver Quality Alert:\nDriver: ${driverName} (${driverRes.rows[0]?.phone})\nBooking: #${booking.booking_code}\nRating: ${normalizedRating} Stars\nCategory: ${input.feedbackCategory || 'Unspecified'}\nNew Average: ${calculatedRating} ★\nStatus: ${newOnboardingStatus || 'ACTIVE'}`
          );
        }
      }
    }

    const shouldPromptGoogleReview = normalizedRating >= policy.min_rating_for_google_prompt;

    return {
      success: true,
      newDriverRating: calculatedRating,
      shouldPromptGoogleReview,
      googleReviewUrl: policy.google_review_url,
      alertAdmin,
      message: `Rating of ${normalizedRating} recorded for Driver #${driverId}.`,
    };
  });
}

/**
 * Admin action to dispute/exclude a customer rating and recalculate driver's score.
 */
export async function disputeRating(
  ratingId: number,
  adminId: number,
  notes: string
): Promise<{ success: boolean; newDriverRating: number }> {
  const policy = await getDriverRatingPolicy();

  return withTransaction(async (client: PoolClient) => {
    const rRes = await client.query(
      `UPDATE crm_driver_ratings
       SET is_disputed = true,
           dispute_resolution_notes = $1,
           resolved_by_admin_id = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING driver_id`,
      [notes, adminId, ratingId]
    );

    if (rRes.rows.length === 0) {
      throw new Error(`Rating record #${ratingId} not found.`);
    }

    const driverId = rRes.rows[0].driver_id;

    // Recalculate without disputed ratings
    const statsRes = await client.query(
      `SELECT 
         COUNT(*) AS total_ratings,
         COALESCE(AVG(rating), $2) AS avg_rating,
         COUNT(*) FILTER (WHERE rating = 5) AS count_5,
         COUNT(*) FILTER (WHERE rating = 1) AS count_1
       FROM crm_driver_ratings
       WHERE driver_id = $1 AND is_disputed = false`,
      [driverId, policy.default_initial_rating]
    );

    const calculatedRating = parseFloat(Number(statsRes.rows[0].avg_rating).toFixed(2));
    const totalRatings = parseInt(statsRes.rows[0].total_ratings, 10);
    const count5 = parseInt(statsRes.rows[0].count_5, 10);
    const count1 = parseInt(statsRes.rows[0].count_1, 10);

    await client.query(
      `UPDATE crm_drivers
       SET rating = $1,
           total_ratings_count = $2,
           rating_5_count = $3,
           rating_1_count = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [calculatedRating, totalRatings, count5, count1, driverId]
    );

    return {
      success: true,
      newDriverRating: calculatedRating,
    };
  });
}

/**
 * Retrieve comprehensive rating and feedback profile for a driver.
 */
export async function getDriverRatingProfile(driverId: number): Promise<DriverRatingSummary | null> {
  const dRes = await query(
    `SELECT id, full_name, rating, total_trips_completed, total_ratings_count, rating_5_count, rating_1_count
     FROM crm_drivers WHERE id = $1`,
    [driverId]
  );

  if (dRes.rows.length === 0) return null;
  const d = dRes.rows[0];

  const reviewsRes = await query(
    `SELECT id, booking_id, rating, feedback_category, customer_comment, is_disputed, created_at
     FROM crm_driver_ratings
     WHERE driver_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [driverId]
  );

  return {
    driverId: d.id,
    driverName: d.full_name,
    currentRating: Number(d.rating),
    totalTripsCompleted: Number(d.total_trips_completed || 0),
    totalRatingsCount: Number(d.total_ratings_count || 0),
    rating5Count: Number(d.rating_5_count || 0),
    rating1Count: Number(d.rating_1_count || 0),
    recentReviews: reviewsRes.rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      rating: r.rating,
      feedbackCategory: r.feedback_category,
      customerComment: r.customer_comment,
      isDisputed: r.is_disputed,
      createdAt: r.created_at,
    })),
  };
}

