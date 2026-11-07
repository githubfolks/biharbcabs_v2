'use client';

import { useState, useEffect } from 'react';
import { Settings, Save, RefreshCw, Sliders, Shield, MessageSquare, Database, Star, DollarSign, Award, ShieldCheck, Landmark } from 'lucide-react';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  async function loadSettings() {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.success) {
        setSettings(data.settings);
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  async function handleSaveSetting(key: string, value: any) {
    setSavingKey(key);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const data = await res.json();
      if (data.success) {
        setSettings(data.settings);
        alert(`Setting '${key}' saved to database successfully!`);
      } else {
        alert(data.error || 'Failed to update setting');
      }
    } catch (err: any) {
      alert('Error updating setting: ' + err.message);
    } finally {
      setSavingKey(null);
    }
  }

  const slaTimeout = settings.dispatch_sla_timeout_minutes?.value ?? 15;
  const returnPolicy = settings.return_trip_policy ?? { enabled: false, discount_type: 'PERCENT', discount_value: null, exclusive_window_minutes: 10, return_status_hours: null };
  const wakeupHours = settings.driver_wakeup_check_hours_before?.value ?? 2;
  const commModel = settings.commission_model ?? { type: 'PERCENTAGE', percentage: 12.0, fixed_margin: 300 };
  const maxNegative = settings.driver_max_negative_balance_limit?.value ?? 1500;
  const wpApi = settings.biharcabs_wp_api ?? { base_url: 'http://localhost:8080', quote_endpoint: '/wp-json/biharcabs/v1/quote' };
  const ratingPolicy = settings.driver_rating_policy ?? {
    default_initial_rating: 5.0,
    min_dispatch_rating: 4.10,
    critical_alert_threshold: 3.80,
    auto_suspend_consecutive_1_stars: 2,
    google_review_url: 'https://g.page/r/biharcabs/review',
    min_rating_for_google_prompt: 4,
    rating_timeout_hours: 48,
  };
  const revPolicy = settings.revenue_protection_policy ?? {
    advance_token_percentage: 10.0,
    min_advance_amount: 200.0,
    platform_commission_pct: 10.0,
    gst_on_commission_pct: 18.0,
    tech_fee_amount: 10.0,
    customer_convenience_fee: 39.0,
    night_surcharge: 200.0,
    roof_luggage_carrier_fee: 150.0,
    dynamic_credit_limits: {
      probation_or_new: 300.0,
      standard: 1000.0,
      elite: 2500.0,
    },
    elite_min_rating: 4.80,
    elite_min_trips: 25,
    standard_min_rating: 4.20,
    standard_min_trips: 5,
    company_upi_vpa: 'biharcabs@icici',
    company_upi_name: 'BiharCabs Private Limited',
    enable_digital_only_soft_mode: true,
    min_dues_for_micro_recharge: 50.0,
    target_security_reserve: 500.0,
    reserve_deduction_per_trip: 100.0,
    streak_bonus_target_trips: 5,
    streak_bonus_amount: 150.0,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Dynamic System Settings</h1>
          <p className="text-sm text-slate-500">Zero hardcoded values &bull; All configurations stored dynamically in native PostgreSQL</p>
        </div>
        <button
          onClick={() => loadSettings()}
          className="inline-flex items-center px-3 py-2 border border-slate-300 shadow-sm text-sm font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Reload from DB
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* SLA & Dispatch Configuration */}
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center space-x-2 border-b pb-3">
            <Sliders className="h-5 w-5 text-orange-600" />
            <h3 className="font-bold text-slate-900">Dispatch SLAs & Wake-up Check</h3>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">Driver Acceptance SLA Timeout (Minutes)</label>
            <p className="text-xs text-slate-500 mb-1">Time before an unconfirmed driver broadcast triggers an admin alert</p>
            <div className="flex space-x-2">
              <input
                type="number"
                defaultValue={slaTimeout}
                id="sla_input"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
              <button
                onClick={() => {
                  const val = Number((document.getElementById('sla_input') as HTMLInputElement).value);
                  handleSaveSetting('dispatch_sla_timeout_minutes', { value: val });
                }}
                disabled={savingKey === 'dispatch_sla_timeout_minutes'}
                className="px-3 py-1.5 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700"
              >
                Save
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">Driver Wake-Up Check (Hours Prior to Pickup)</label>
            <p className="text-xs text-slate-500 mb-1">Automated WhatsApp check-in requiring driver to confirm readiness</p>
            <div className="flex space-x-2">
              <input
                type="number"
                defaultValue={wakeupHours}
                id="wakeup_input"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
              <button
                onClick={() => {
                  const val = Number((document.getElementById('wakeup_input') as HTMLInputElement).value);
                  handleSaveSetting('driver_wakeup_check_hours_before', { value: val });
                }}
                disabled={savingKey === 'driver_wakeup_check_hours_before'}
                className="px-3 py-1.5 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>

        {/* Return Trips */}
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-3">
          <div className="flex items-center space-x-2 border-b pb-3">
            <Sliders className="h-5 w-5 text-orange-600" />
            <h3 className="font-bold text-slate-900">Return Trips: Priority & Customer Discount</h3>
          </div>
          <p className="text-xs text-slate-500">
            After a drop away from home, a driver can tap &quot;Returning home&quot;. Rides from that city to their base city are then
            offered to them first, and customers see a discount. The company pays the discount up to its commission and the
            returning driver pays the rest; if a regular driver takes the ride, the company pays it all.
          </p>
          <label className="flex items-center space-x-2 text-xs font-semibold text-slate-700">
            <input type="checkbox" id="rt_enabled" defaultChecked={returnPolicy.enabled === true} />
            <span>Switch on return-trip priority and discount</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Discount type</label>
              <select id="rt_type" defaultValue={returnPolicy.discount_type || 'PERCENT'} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm">
                <option value="PERCENT">% of fare</option>
                <option value="FLAT">Flat ₹ amount</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Discount value</label>
              <input type="number" min="0" step="any" id="rt_value" defaultValue={returnPolicy.discount_value ?? ''} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Priority window (minutes)</label>
              <input type="number" min="1" max="120" id="rt_window" defaultValue={returnPolicy.exclusive_window_minutes ?? ''} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Return status lasts (hours)</label>
              <input type="number" min="1" max="48" step="any" id="rt_hours" defaultValue={returnPolicy.return_status_hours ?? ''} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono" />
            </div>
          </div>
          <button
            onClick={() => {
              const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
              const num = (id: string) => (val(id) === '' ? null : Number(val(id)));
              handleSaveSetting('return_trip_policy', {
                enabled: (document.getElementById('rt_enabled') as HTMLInputElement).checked,
                discount_type: val('rt_type'),
                discount_value: num('rt_value'),
                exclusive_window_minutes: num('rt_window'),
                return_status_hours: num('rt_hours'),
              });
            }}
            disabled={savingKey === 'return_trip_policy'}
            className="px-3 py-1.5 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700"
          >
            Save Return Trip Settings
          </button>
        </div>

        {/* Commission & Finance Rules */}
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center space-x-2 border-b pb-3">
            <Shield className="h-5 w-5 text-emerald-600" />
            <h3 className="font-bold text-slate-900">Commission & Wallet Rules</h3>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">Commission Percentage (%)</label>
            <p className="text-xs text-slate-500 mb-1">Default company platform commission deducted from driver earnings</p>
            <div className="flex space-x-2">
              <input
                type="number"
                step="0.5"
                defaultValue={commModel.percentage}
                id="comm_input"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
              <button
                onClick={() => {
                  const pct = Number((document.getElementById('comm_input') as HTMLInputElement).value);
                  handleSaveSetting('commission_model', { ...commModel, percentage: pct });
                }}
                disabled={savingKey === 'commission_model'}
                className="px-3 py-1.5 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700"
              >
                Save
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">Driver Max Negative Balance Limit (₹)</label>
            <p className="text-xs text-slate-500 mb-1">Drivers owing more than this amount are suspended from ride broadcasts</p>
            <div className="flex space-x-2">
              <input
                type="number"
                defaultValue={maxNegative}
                id="neg_input"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
              <button
                onClick={() => {
                  const val = Number((document.getElementById('neg_input') as HTMLInputElement).value);
                  handleSaveSetting('driver_max_negative_balance_limit', { value: val });
                }}
                disabled={savingKey === 'driver_max_negative_balance_limit'}
                className="px-3 py-1.5 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>

        {/* Live Tariff Bridge & WordPress API Connector */}
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4 md:col-span-2">
          <div className="flex items-center space-x-2 border-b pb-3">
            <Database className="h-5 w-5 text-blue-600" />
            <h3 className="font-bold text-slate-900">BiharCabs.com Live Pricing Tariff Bridge</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700">WordPress Base URL</label>
              <input
                type="text"
                defaultValue={wpApi.base_url}
                id="wp_base_url"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Quote Endpoint</label>
              <input
                type="text"
                defaultValue={wpApi.quote_endpoint}
                id="wp_quote_endpoint"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                const base = (document.getElementById('wp_base_url') as HTMLInputElement).value;
                const endpoint = (document.getElementById('wp_quote_endpoint') as HTMLInputElement).value;
                handleSaveSetting('biharcabs_wp_api', { ...wpApi, base_url: base, quote_endpoint: endpoint });
              }}
              disabled={savingKey === 'biharcabs_wp_api'}
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700"
            >
              Update Pricing Connector
            </button>
          </div>
        </div>

        {/* Driver Ratings & Quality Assurance Policy */}
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4 md:col-span-2">
          <div className="flex items-center space-x-2 border-b pb-3">
            <Star className="h-5 w-5 text-amber-500 fill-amber-500" />
            <div>
              <h3 className="font-bold text-slate-900">Driver Ratings & Quality Assurance Policy</h3>
              <p className="text-xs text-slate-500">Configure minimum dispatch thresholds, Google Review redirect rules, and auto-suspension</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Minimum Rating for Dispatch Eligibility</label>
              <p className="text-[11px] text-slate-500 mb-1">Drivers below this rating are excluded from automatic broadcasts</p>
              <input
                type="number"
                step="0.05"
                min="1.0"
                max="5.0"
                defaultValue={ratingPolicy.min_dispatch_rating}
                id="policy_min_dispatch"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Critical Quality Alert Threshold</label>
              <p className="text-[11px] text-slate-500 mb-1">Triggers immediate WhatsApp alerts to operations admins</p>
              <input
                type="number"
                step="0.05"
                min="1.0"
                max="5.0"
                defaultValue={ratingPolicy.critical_alert_threshold}
                id="policy_critical_alert"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Auto-Suspend on Consecutive 1-Stars</label>
              <p className="text-[11px] text-slate-500 mb-1">Number of consecutive 1-star ratings that freeze driver account</p>
              <input
                type="number"
                min="1"
                max="10"
                defaultValue={ratingPolicy.auto_suspend_consecutive_1_stars}
                id="policy_consecutive_1_stars"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Google Review Referral URL</label>
              <p className="text-[11px] text-slate-500 mb-1">Sent to customers who rate 4 or 5 stars to drive 5-star organic reviews</p>
              <input
                type="text"
                defaultValue={ratingPolicy.google_review_url}
                id="policy_google_url"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Min Stars to Trigger Google Review Link</label>
              <p className="text-[11px] text-slate-500 mb-1">Default 4 (Passengers giving 4 or 5 stars receive review prompt)</p>
              <input
                type="number"
                min="1"
                max="5"
                defaultValue={ratingPolicy.min_rating_for_google_prompt}
                id="policy_google_min_stars"
                className="w-full px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                const minDispatch = parseFloat((document.getElementById('policy_min_dispatch') as HTMLInputElement).value);
                const critAlert = parseFloat((document.getElementById('policy_critical_alert') as HTMLInputElement).value);
                const consec1 = parseInt((document.getElementById('policy_consecutive_1_stars') as HTMLInputElement).value, 10);
                const googleUrl = (document.getElementById('policy_google_url') as HTMLInputElement).value;
                const minGoogle = parseInt((document.getElementById('policy_google_min_stars') as HTMLInputElement).value, 10);

                const payload = {
                  default_initial_rating: 5.0,
                  min_dispatch_rating: minDispatch,
                  critical_alert_threshold: critAlert,
                  auto_suspend_consecutive_1_stars: consec1,
                  google_review_url: googleUrl,
                  min_rating_for_google_prompt: minGoogle,
                  rating_timeout_hours: 48,
                };

                handleSaveSetting('driver_rating_policy', payload);
              }}
              disabled={savingKey === 'driver_rating_policy'}
              className="px-4 py-2 bg-amber-600 text-white rounded-md text-xs font-semibold hover:bg-amber-700"
            >
              Save Rating & Quality Policy
            </button>
          </div>
        </div>

        {/* Revenue Protection, Tax Compliance & Dues Recovery Policy */}
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4 md:col-span-2">
          <div className="flex items-center space-x-2 border-b pb-3">
            <ShieldCheck className="h-5 w-5 text-indigo-600" />
            <div>
              <h3 className="font-bold text-slate-900">Revenue Protection, Take-Rate &amp; Dues Recovery Policy</h3>
              <p className="text-xs text-slate-500">Configure advance booking tokens, 18% GST splits, customer convenience fees, dynamic credit limits, rolling reserves &amp; streak bonuses</p>
            </div>
          </div>

          <div className="space-y-4">
            {/* Row 1: Universal Advance Token & Tax Split */}
            <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200/80">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2 flex items-center">
                <DollarSign className="h-4 w-4 mr-1 text-emerald-600" />
                Customer Advance Token, Platform Take-Rate &amp; Statutory GST (CGST Sec 9(5))
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Customer Advance Token (%)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Upfront token to eliminate credit risk</p>
                  <input
                    type="number"
                    step="0.5"
                    defaultValue={revPolicy.advance_token_percentage}
                    id="rev_advance_token"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Min Advance Token Amount (₹)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Minimum upfront token payable</p>
                  <input
                    type="number"
                    step="50"
                    defaultValue={revPolicy.min_advance_amount ?? 200.0}
                    id="rev_min_advance"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Platform Facilitation / Take-Rate (%)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Company commission on total fare (e.g. 10%)</p>
                  <input
                    type="number"
                    step="0.5"
                    defaultValue={revPolicy.platform_commission_pct ?? revPolicy.platform_facilitation_percentage ?? 10.0}
                    id="rev_platform_fee"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono font-bold text-indigo-700"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Statutory GST on Commission (%)</label>
                  <p className="text-[10px] text-slate-400 mb-1">18% GST levied on facilitation</p>
                  <input
                    type="number"
                    step="0.5"
                    defaultValue={revPolicy.gst_on_commission_pct ?? revPolicy.statutory_gst_percentage ?? 18.0}
                    id="rev_gst_percentage"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
              </div>

              {/* Ancillary customer fees */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 pt-3 border-t border-slate-200">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Customer Platform Convenience Fee (₹)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Added to customer invoice (e.g. ₹39)</p>
                  <input
                    type="number"
                    step="1"
                    defaultValue={revPolicy.customer_convenience_fee ?? 39.0}
                    id="rev_convenience_fee"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Flat Tech Dispatch Fee (₹)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Software dispatch charge per booking</p>
                  <input
                    type="number"
                    step="1"
                    defaultValue={revPolicy.tech_fee_amount ?? revPolicy.flat_tech_fee ?? 10.0}
                    id="rev_tech_fee"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Night Pickup Surcharge (₹)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Between 10:00 PM – 06:00 AM</p>
                  <input
                    type="number"
                    step="10"
                    defaultValue={revPolicy.night_surcharge ?? 200.0}
                    id="rev_night_surcharge"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Row 2: Dynamic Credit Leeway Thresholds */}
            <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200/80">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2 flex items-center">
                <Award className="h-4 w-4 mr-1 text-amber-600" />
                Dynamic Driver Credit Limits (Earn Trust, Get Leeway)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="p-2.5 bg-white rounded border border-rose-200">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-bold text-rose-700">Probation Tier</span>
                    <span className="text-[10px] text-slate-400">&lt;5 trips or &lt;4.2★</span>
                  </div>
                  <label className="block text-[10px] font-medium text-slate-600">Max Negative Dues Limit (₹)</label>
                  <input
                    type="number"
                    defaultValue={revPolicy.dynamic_credit_limits?.probation_or_new ?? revPolicy.probation_limit ?? 300.0}
                    id="rev_probation_limit"
                    className="w-full mt-1 px-2.5 py-1 border rounded text-sm font-mono text-rose-600 font-bold"
                  />
                </div>

                <div className="p-2.5 bg-white rounded border border-blue-200">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-bold text-blue-700">Standard Tier</span>
                    <span className="text-[10px] text-slate-400">≥5 trips &amp; ≥4.2★</span>
                  </div>
                  <label className="block text-[10px] font-medium text-slate-600">Max Negative Dues Limit (₹)</label>
                  <input
                    type="number"
                    defaultValue={revPolicy.dynamic_credit_limits?.standard ?? revPolicy.standard_limit ?? 1000.0}
                    id="rev_standard_limit"
                    className="w-full mt-1 px-2.5 py-1 border rounded text-sm font-mono text-blue-600 font-bold"
                  />
                  <div className="grid grid-cols-2 gap-1.5 mt-2">
                    <div>
                      <label className="block text-[9px] text-slate-500">Min Trips</label>
                      <input
                        type="number"
                        defaultValue={revPolicy.standard_min_trips ?? 5}
                        id="rev_standard_min_trips"
                        className="w-full px-1.5 py-0.5 border rounded text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] text-slate-500">Min Rating</label>
                      <input
                        type="number"
                        step="0.05"
                        defaultValue={revPolicy.standard_min_rating ?? 4.20}
                        id="rev_standard_min_rating"
                        className="w-full px-1.5 py-0.5 border rounded text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>

                <div className="p-2.5 bg-white rounded border border-emerald-200">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-bold text-emerald-700">Elite Fleet Partner</span>
                    <span className="text-[10px] text-slate-400">≥25 trips &amp; ≥4.8★</span>
                  </div>
                  <label className="block text-[10px] font-medium text-slate-600">Max Negative Dues Limit (₹)</label>
                  <input
                    type="number"
                    defaultValue={revPolicy.dynamic_credit_limits?.elite ?? revPolicy.elite_limit ?? 2500.0}
                    id="rev_elite_limit"
                    className="w-full mt-1 px-2.5 py-1 border rounded text-sm font-mono text-emerald-600 font-bold"
                  />
                  <div className="grid grid-cols-2 gap-1.5 mt-2">
                    <div>
                      <label className="block text-[9px] text-slate-500">Min Trips</label>
                      <input
                        type="number"
                        defaultValue={revPolicy.elite_min_trips ?? 25}
                        id="rev_elite_min_trips"
                        className="w-full px-1.5 py-0.5 border rounded text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] text-slate-500">Min Rating</label>
                      <input
                        type="number"
                        step="0.05"
                        defaultValue={revPolicy.elite_min_rating ?? 4.80}
                        id="rev_elite_min_rating"
                        className="w-full px-1.5 py-0.5 border rounded text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Row 3: Rolling Reserve Float & Streak Bonuses */}
            <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200/80">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2 flex items-center">
                <Landmark className="h-4 w-4 mr-1 text-purple-600" />
                Rolling Security Reserve Float &amp; Ride Streak Milestone Bonuses
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Target Security Reserve (₹)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Target float accumulated per driver</p>
                  <input
                    type="number"
                    defaultValue={revPolicy.target_security_reserve}
                    id="rev_target_reserve"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Reserve Deduction per Trip (₹)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Deducted only from positive advance payouts</p>
                  <input
                    type="number"
                    defaultValue={revPolicy.reserve_deduction_per_trip}
                    id="rev_deduction_per_trip"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Streak Milestone Target (Trips)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Every N trips grants a bonus</p>
                  <input
                    type="number"
                    defaultValue={revPolicy.streak_bonus_target_trips}
                    id="rev_streak_trips"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700">Streak Bonus Amount (₹)</label>
                  <p className="text-[10px] text-slate-400 mb-1">Credited to wallet &amp; clears dues first</p>
                  <input
                    type="number"
                    defaultValue={revPolicy.streak_bonus_amount}
                    id="rev_streak_amount"
                    className="w-full px-2.5 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Row 4: UPI Deep Link VPA & Soft Mode */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700">Company UPI VPA</label>
                <input
                  type="text"
                  defaultValue={revPolicy.company_upi_vpa}
                  id="rev_upi_vpa"
                  className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-700">Company Beneficiary Name</label>
                <input
                  type="text"
                  defaultValue={revPolicy.company_upi_name}
                  id="rev_upi_name"
                  className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-700">Min Dues for UPI QR (₹)</label>
                <input
                  type="number"
                  defaultValue={revPolicy.min_dues_for_micro_recharge ?? 50.0}
                  id="rev_min_dues_recharge"
                  className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm font-mono"
                />
              </div>
              <div className="flex items-center space-x-2 pt-6">
                <input
                  type="checkbox"
                  defaultChecked={revPolicy.enable_digital_only_soft_mode}
                  id="rev_soft_mode"
                  className="h-4 w-4 text-indigo-600 rounded"
                />
                <label htmlFor="rev_soft_mode" className="text-xs font-semibold text-slate-700">
                  Digital-Only Soft Mode
                </label>
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                const advToken = parseFloat((document.getElementById('rev_advance_token') as HTMLInputElement).value);
                const minAdvance = parseFloat((document.getElementById('rev_min_advance') as HTMLInputElement).value);
                const platFee = parseFloat((document.getElementById('rev_platform_fee') as HTMLInputElement).value);
                const gstRate = parseFloat((document.getElementById('rev_gst_percentage') as HTMLInputElement).value);
                const techFee = parseFloat((document.getElementById('rev_tech_fee') as HTMLInputElement).value);
                const convenienceFee = parseFloat((document.getElementById('rev_convenience_fee') as HTMLInputElement).value);
                const nightSurcharge = parseFloat((document.getElementById('rev_night_surcharge') as HTMLInputElement).value);
                const probLimit = parseFloat((document.getElementById('rev_probation_limit') as HTMLInputElement).value);
                const stdLimit = parseFloat((document.getElementById('rev_standard_limit') as HTMLInputElement).value);
                const eliteLimit = parseFloat((document.getElementById('rev_elite_limit') as HTMLInputElement).value);
                const stdTrips = parseInt((document.getElementById('rev_standard_min_trips') as HTMLInputElement).value, 10);
                const stdRating = parseFloat((document.getElementById('rev_standard_min_rating') as HTMLInputElement).value);
                const eliteTrips = parseInt((document.getElementById('rev_elite_min_trips') as HTMLInputElement).value, 10);
                const eliteRating = parseFloat((document.getElementById('rev_elite_min_rating') as HTMLInputElement).value);
                const targetRes = parseFloat((document.getElementById('rev_target_reserve') as HTMLInputElement).value);
                const deductTrip = parseFloat((document.getElementById('rev_deduction_per_trip') as HTMLInputElement).value);
                const streakTrips = parseInt((document.getElementById('rev_streak_trips') as HTMLInputElement).value, 10);
                const streakAmt = parseFloat((document.getElementById('rev_streak_amount') as HTMLInputElement).value);
                const upiVpa = (document.getElementById('rev_upi_vpa') as HTMLInputElement).value;
                const upiName = (document.getElementById('rev_upi_name') as HTMLInputElement).value;
                const minDuesRecharge = parseFloat((document.getElementById('rev_min_dues_recharge') as HTMLInputElement).value);
                const softMode = (document.getElementById('rev_soft_mode') as HTMLInputElement).checked;

                const payload = {
                  advance_token_percentage: advToken,
                  min_advance_amount: minAdvance,
                  platform_commission_pct: platFee,
                  platform_facilitation_percentage: platFee,
                  gst_on_commission_pct: gstRate,
                  statutory_gst_percentage: gstRate,
                  tech_fee_amount: techFee,
                  flat_tech_fee: techFee,
                  customer_convenience_fee: convenienceFee,
                  night_surcharge: nightSurcharge,
                  roof_luggage_carrier_fee: 150.0,
                  dynamic_credit_limits: {
                    probation_or_new: probLimit,
                    standard: stdLimit,
                    elite: eliteLimit,
                  },
                  probation_limit: probLimit,
                  standard_limit: stdLimit,
                  elite_limit: eliteLimit,
                  standard_min_trips: stdTrips,
                  elite_min_trips: eliteTrips,
                  standard_min_rating: stdRating,
                  elite_min_rating: eliteRating,
                  company_upi_vpa: upiVpa,
                  company_upi_name: upiName,
                  enable_digital_only_soft_mode: softMode,
                  min_dues_for_micro_recharge: minDuesRecharge,
                  target_security_reserve: targetRes,
                  reserve_deduction_per_trip: deductTrip,
                  streak_bonus_target_trips: streakTrips,
                  streak_bonus_amount: streakAmt,
                };

                handleSaveSetting('revenue_protection_policy', payload);
              }}
              disabled={savingKey === 'revenue_protection_policy'}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md text-xs font-semibold hover:bg-indigo-700"
            >
              Save Revenue Protection &amp; Tax Policy
            </button>
          </div>
        </div>

        {/* WhatsApp Bot Intents & Responses Manager */}
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4 md:col-span-2">
          <div className="flex items-center space-x-2 border-b pb-3">
            <MessageSquare className="h-5 w-5 text-emerald-600" />
            <div>
              <h3 className="font-bold text-slate-900">WhatsApp Bot Intents & Conversational Prompts</h3>
              <p className="text-xs text-slate-500">Configure trigger keywords, customer greetings, driver onboarding, and fallback responses</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Customer Greeting Keywords (comma-separated)</label>
              <input
                type="text"
                defaultValue={settings.whatsapp_intents?.greetings?.keywords?.join(', ') || 'hi, hello, namaste, cab, booking, pranam'}
                id="intent_greet_kw"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Driver Onboarding Keywords (comma-separated)</label>
              <input
                type="text"
                defaultValue={settings.whatsapp_intents?.driver_onboarding?.keywords?.join(', ') || 'join, attach, driver, partner, fleet'}
                id="intent_driver_kw"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Customer Welcome Message</label>
              <textarea
                rows={3}
                defaultValue={settings.whatsapp_intents?.greetings?.welcome_message || `Namaste! Welcome to BiharCabs.com — Bihar's #1 Intercity & Airport Cab Service.\n\nHow can we help you today? Please choose your trip type:`}
                id="intent_greet_msg"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Driver Onboarding Welcome Prompt</label>
              <textarea
                rows={3}
                defaultValue={settings.whatsapp_intents?.driver_onboarding?.prompt_name || `🚖 Welcome to BiharCabs Fleet Partner Onboarding!\n\nPlease reply with your Full Name (as per your Driving License):`}
                id="intent_driver_prompt"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Ask Origin City Prompt</label>
              <input
                type="text"
                defaultValue={settings.whatsapp_intents?.customer_prompts?.ask_origin || 'Which city will you be picked up from? (e.g. Patna, Darbhanga, Gaya, Muzaffarpur):'}
                id="intent_ask_origin"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Ask Destination Prompt</label>
              <input
                type="text"
                defaultValue={settings.whatsapp_intents?.customer_prompts?.ask_destination || 'Enter destination city or drop location:'}
                id="intent_ask_dest"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">Ask Landmark Prompt</label>
              <input
                type="text"
                defaultValue={settings.whatsapp_intents?.customer_prompts?.ask_landmark || 'Please reply with your exact Pickup Landmark & Address in {origin}:'}
                id="intent_ask_landmark"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">Fallback / Unrecognized Message</label>
            <textarea
              rows={2}
              defaultValue={settings.whatsapp_intents?.fallback_message || `Namaste! For instant cab booking, please reply with "HI" or send your pickup and drop city (e.g. "Patna to Darbhanga tomorrow").\n\nFor 24/7 customer support, call +91 7070992170.`}
              id="intent_fallback"
              className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
            />
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                const greetKw = (document.getElementById('intent_greet_kw') as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean);
                const driverKw = (document.getElementById('intent_driver_kw') as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean);
                const greetMsg = (document.getElementById('intent_greet_msg') as HTMLTextAreaElement).value;
                const driverPrompt = (document.getElementById('intent_driver_prompt') as HTMLTextAreaElement).value;
                const askOrigin = (document.getElementById('intent_ask_origin') as HTMLInputElement).value;
                const askDest = (document.getElementById('intent_ask_dest') as HTMLInputElement).value;
                const askLandmark = (document.getElementById('intent_ask_landmark') as HTMLInputElement).value;
                const fallback = (document.getElementById('intent_fallback') as HTMLTextAreaElement).value;

                const payload = {
                  greetings: {
                    keywords: greetKw,
                    welcome_message: greetMsg,
                    buttons: settings.whatsapp_intents?.greetings?.buttons || [
                      { id: 'tt_oneway', title: '🚖 One-Way Drop' },
                      { id: 'tt_roundtrip', title: '🔄 Round Trip' },
                      { id: 'tt_airport', title: '✈️ Airport Cab' },
                    ],
                  },
                  driver_onboarding: {
                    keywords: driverKw,
                    prompt_name: driverPrompt,
                    prompt_city: settings.whatsapp_intents?.driver_onboarding?.prompt_city || 'Which city in Bihar is your main operating base?',
                    prompt_vehicle: settings.whatsapp_intents?.driver_onboarding?.prompt_vehicle || 'Which type of commercial vehicle do you operate?',
                    prompt_reg: settings.whatsapp_intents?.driver_onboarding?.prompt_reg || 'Please enter your Commercial Vehicle Registration Number (e.g. BR-01-PK-1234):',
                  },
                  customer_prompts: {
                    ask_origin: askOrigin,
                    ask_destination: askDest,
                    ask_landmark: askLandmark,
                    custom_quote_notice: settings.whatsapp_intents?.customer_prompts?.custom_quote_notice || 'Thank you for contacting BiharCabs! Our route specialist is calculating the best custom rate for your location and will share your price card shortly.',
                  },
                  fallback_message: fallback,
                };

                handleSaveSetting('whatsapp_intents', payload);
              }}
              disabled={savingKey === 'whatsapp_intents'}
              className="px-4 py-2 bg-emerald-600 text-white rounded-md text-xs font-semibold hover:bg-emerald-700"
            >
              Save WhatsApp Intents
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

