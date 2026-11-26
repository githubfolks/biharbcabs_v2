# Driver WhatsApp Flow & Local Simulation Guide

This guide documents the exact WhatsApp messages, interactive buttons, backend state transitions, and step-by-step instructions to test the complete Driver lifecycle locally using the CRM **WA Simulator** (`http://localhost:3001/simulator`).

---

## 1. End-to-End Driver WhatsApp Flow

### Step 1 — New Ride Broadcast (`AWAITING_DRIVER`)
Sent automatically to all eligible active, verified drivers in the pickup `base_city` (from `crm/src/lib/dispatch-notify.ts`).

**Message to Driver:**
> **BiharCabs Dispatch Alert**
> 🚖 New Ride Alert (`#BC-...`)!
> Route: `<Origin> → <Destination>`
> Pickup: `<Date & Time>`
> Cab: `<CAB_CODE>`
>
> 💵 Fare Details:
> Total Fare: `₹<Total>`
> 👉 COLLECT CASH AT DROP: `₹<Total>`
> Your Net Earnings: `₹<Driver Payout>`
>
> First to tap Accept gets the ride!

**Interactive Buttons:**
- `✅ Accept Ride` (`accept_ride_<bookingId>`)
- `❌ Decline` (`decline_ride_<bookingId>`)

---

### Step 2 — Driver Accepts or Declines (`DRIVER_ASSIGNED`)
- **If Driver taps `✅ Accept Ride`:**
  - Atomic first-accept lock assigns the ride to that driver (`DRIVER_ASSIGNED`) and expires all other drivers' pending offers.
  - Records `DRIVER_ASSIGNED` and `START_OTP_ISSUED` in `crm_booking_events` (**Ride Timeline**).
  - **Driver receives:**
    > **Trip Details & Cash Collection**
    > 🚖 Trip `#BC-...` Confirmed!
    > Pickup: `<pickup address>`
    > Date: `<date>` at `<time>`
    > Customer: `<name> (<phone>)`
    >
    > 💵 Payment Breakdown (Total Fare, Advance Paid, 👉 COLLECT CASH AT DROP, Your Net Payout)
    >
    > 🔐 At pickup, tap **Start Trip** and enter the OTP the customer received.
    - **Button:** `🚀 Start Trip` (`start_trip_<bookingId>`)
  - **Customer simultaneously receives:** Driver name, driver phone, cab registration number, and their **4-digit Start OTP** (`🔐 Trip OTP for booking #BC-...: *1234*`).
- **If Driver taps `❌ Decline`:**
  - Offer is marked `DECLINED`, logged as `DRIVER_OFFER_DECLINED` in the Ride Timeline, and the ride remains open for other eligible drivers.

---

### Step 3 — T-2h Wake-Up Check (Automated Cron)
- Before scheduled pickup, the cron job sends `⏰ Upcoming Pickup Reminder (#BC-...)` with button **`⏰ I Am Ready & On Time`**.
- Tapping it (or replying `Ready`) records `WAKEUP_CONFIRMED` in the Ride Timeline.
- If unconfirmed within the alert window, CRM admins receive an alert to call or reassign the driver.

---

### Step 4 — Pickup & Start Trip (`TRIP_IN_PROGRESS`)
- Driver taps **`🚀 Start Trip`** (or types `start trip <bookingId>`).
- Bot prompts:
  > `🔐 Trip #BC-...: ask the customer for their trip OTP (sent to them on WhatsApp) and type it here to start the trip.`
- Driver types the customer's **4-digit OTP**:
  - **Non-numeric input:** Bot reminds the driver to enter the 4-digit numeric OTP (never falls through to customer prompts).
  - **Wrong OTP:** Failed attempt counted and logged (`START_OTP_FAILED`); locks after max attempts (`START_OTP_LOCKED`).
  - **Correct OTP:** Status updates to **`TRIP_IN_PROGRESS`**, records `TRIP_STARTED` in the Ride Timeline:
    - **Driver receives:** `✅ OTP verified. Trip #BC-... is now IN PROGRESS. Collect ₹<amount> in cash at drop, then tap below:` with button **`🏁 Complete Trip`** (`complete_trip_<bookingId>`).
    - **Customer receives:** `🚖 Your BiharCabs trip (#BC-...) has started! Have a pleasant and safe journey.`

---

### Step 5 — Drop-Off, Settlement & Rating (`COMPLETED_SETTLED`)
- Driver taps **`🏁 Complete Trip`**.
- Backend executes `completeTripAndSettle()`:
  - Marks booking **`COMPLETED_SETTLED`** and records `TRIP_COMPLETED` in the Ride Timeline.
  - Updates driver wallet balance, records double-entry ledger entries (`crm_payments_ledger`), and generates the GST invoice number.
- **Driver receives:**
  > `🏁 Trip #BC-... Completed & Settled!` with Total Fare, Cash Collected, BiharCabs Commission, Net Settlement, and updated Wallet Balance.
  - If dropped outside their `base_city`, also receives a **`🔁 Returning home`** button for priority return-trip matching.
- **Customer simultaneously receives:** Trip completion summary, invoice number, and **1-tap Star Rating buttons** for the driver.

---

## 2. How to Simulate This Locally (30-Second Walkthrough)

1. **Create a Booking:**
   - Book on WordPress (`http://localhost:8081`) — e.g. **Katihar → Purnia**, `Sedan-60KM-4hr` — **OR**
   - Book in CRM (`http://localhost:3001/bookings/new`) with **Trigger WhatsApp driver broadcast immediately** checked.
2. **Open WA Simulator:**
   - Go to `http://localhost:3001/simulator`.
   - Switch the top-left toggle to **Driver Phone** and select an eligible driver in that pickup city:
     - **Katihar:** `#14 Rating Test Driver` (`SEDAN_PETROL`) or `#23 Token Test Driver` (`MICRO_PETROL`)
     - **Purnia:** `#28 Token Test Driver` (`SEDAN_PETROL`) or `#30 Standard Driver` (`SUV_PETROL`)
     - **Patna:** `#1 Test Driver Suresh` (`SEDAN`) or `#66 Soft Mode Driver` (`SEDAN`)
3. **Run the Driver Actions:**
   - Click **`✅ Accept Ride`** on the New Ride Alert message.
   - *(Optional)* Click **Wake-up "Ready"** in Quick Triggers.
   - Switch briefly to **Customer Phone** (enter the customer phone used for the booking) to read the **4-digit Start OTP** (or click **Request "OTP"**).
   - Switch back to **Driver Phone**, click **`🚀 Start Trip`**, and type the 4-digit OTP.
   - Click **`🏁 Complete Trip`** to trigger final settlement, wallet update, and customer rating prompt.
4. **Verify Live Timeline & Ledger:**
   - Click **Timeline** next to the booking in the **Live Bookings** panel (or on `http://localhost:3001`) to verify all chronological events (`BOOKING_CREATED → DRIVER_BROADCAST → DRIVER_ASSIGNED → START_OTP_ISSUED → TRIP_STARTED → TRIP_COMPLETED`).
   - Check `http://localhost:3001/finance` to verify the ledger & GST invoice entries.
