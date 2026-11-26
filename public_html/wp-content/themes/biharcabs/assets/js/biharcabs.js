(function () {
 'use strict';
 const config = window.biharcabs || {};
 const ready = () => {
  const contacts=Array.from(document.querySelectorAll('[data-bc-contact]'));const legacyContact=document.getElementById('lf-form');if(legacyContact)contacts.push(legacyContact);
  contacts.forEach(contact=>{
  if (contact && !contact.dataset.bcBound) {
   contact.dataset.bcBound = '1';
   contact.addEventListener('submit', async event => {
    event.preventDefault(); if (!contact.reportValidity()) return;
    const button = contact.querySelector('[type=submit]'); const status = contact.querySelector('.bc-contact-status');
    const old = button ? button.textContent : ''; if (button) { button.disabled = true; button.textContent = 'Sending…'; }
    const body = new FormData(contact); body.set('action','bc_contact'); body.set('nonce',config.contactNonce);
    try { 
      const response = await fetch(config.ajaxUrl,{method:'POST',credentials:'same-origin',body}); 
      const json = await response.json(); 
      if (status) status.textContent = json.data?.message || 'Unable to send. Please call us.'; 
      if(json.success) contact.reset(); 
    }
    catch (_) { if (status) status.textContent = 'Unable to send. Please call or WhatsApp us.'; }
    finally { if (button) { button.disabled = false; button.textContent = old; } }
   });
  }
  });

  // Helper to save booking lead to WordPress DB asynchronously
  const saveLeadToDB = (data) => {
    if (!config.ajaxUrl) return;
    const fd = new FormData();
    fd.set('action', 'bc_save_booking');
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== null) fd.set(k, String(v));
    }
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(config.ajaxUrl, fd);
      } else {
        fetch(config.ajaxUrl, { method: 'POST', credentials: 'same-origin', body: fd }).catch(() => {});
      }
    } catch (_) {}
  };

  // After handing off to WhatsApp, tell the visitor what to do and give them a way out if it did not open.
  const showNextStep = (form) => {
    let box = form.querySelector('.bc-next-step');
    if (!box) {
      box = document.createElement('div');
      box.className = 'bc-next-step';
      box.setAttribute('role', 'status');
      form.appendChild(box);
    }
    const title = document.createElement('strong');
    title.textContent = 'Almost done: tap Send in WhatsApp so we can confirm your trip.';
    box.replaceChildren(title);
    if (config.phone) {
      const help = document.createElement('p');
      help.textContent = "WhatsApp didn't open? ";
      const call = document.createElement('a');
      call.href = 'tel:' + config.phone;
      call.textContent = 'Call ' + (config.phoneLabel || config.phone);
      help.appendChild(call);
      box.appendChild(help);
    }
    box.scrollIntoView({ block: 'nearest' });
  };

  // Upgrade Elementor-imported Hero forms (#heroBookingForm) in place so they collect basic communication
  // info (Name + Phone), support Rental & Round Trip Return Date, load live CRM plans, and book via CRM API.
  const enhanceHeroForms = () => {
    document.querySelectorAll('.hero-booking-card').forEach(card => {
      if (card.dataset.bcHeroEnhanced) return;
      card.dataset.bcHeroEnhanced = '1';

      const tabsWrap = card.querySelector('.hbc-tabs');
      if (tabsWrap && !Array.from(tabsWrap.querySelectorAll('.hbc-tab')).some(t => /rental/i.test(t.textContent || ''))) {
        const rentalTab = document.createElement('div');
        rentalTab.className = 'hbc-tab';
        rentalTab.textContent = 'Rental';
        tabsWrap.appendChild(rentalTab);
      }

      const form = card.querySelector('form');
      if (!form) return;
      form.setAttribute('data-bc-booking', 'true');
      form.setAttribute('data-bc-source', 'Hero Booking Form');

      const tagField = (sel, role) => {
        const el = form.querySelector(sel);
        if (el && !el.hasAttribute('data-bc-field')) el.setAttribute('data-bc-field', role);
        return el;
      };
      const pickupEl = tagField('#pickup_location, [name*="pickup"]', 'pickup');
      tagField('#drop_location, [name*="drop"]', 'drop');
      const phoneEl = tagField('#phone_hero, [type="tel"], [name*="phone"]', 'phone');
      const dateEl = tagField('#pickup_date, [type="date"]', 'date');
      tagField('#pickup_time, [type="time"]', 'time');
      tagField('#fare_estimate_box', 'estimate');
      tagField('#estimated_distance', 'distance');
      tagField('#auto_detect_btn', 'auto');

      // Ensure Name field exists (basic info required to communicate with customer)
      if (!form.querySelector('[data-bc-field="name"]') && phoneEl) {
        const nameGroup = document.createElement('div');
        nameGroup.className = 'hbc-input-group';
        nameGroup.innerHTML =
          '<label>Your Name <span style="color:#ef4444;">*</span></label>' +
          '<i class="fas fa-user hbc-icon gray"></i>' +
          '<input type="text" data-bc-field="name" class="hbc-input" placeholder="Enter your full name" required minlength="2">';
        const phoneGroup = phoneEl.closest('.hbc-input-group') || phoneEl.parentNode;
        phoneGroup.parentNode.insertBefore(nameGroup, phoneGroup);
      }

      // Ensure Return Date field exists (shown when Round Trip tab is active)
      if (!form.querySelector('[data-bc-field="return_date"]') && dateEl) {
        const retWrap = document.createElement('div');
        retWrap.className = 'hbc-input-group bc-return-date-wrap';
        retWrap.style.display = 'none';
        retWrap.innerHTML =
          '<label>Return Date <span style="color:#ef4444;">*</span></label>' +
          '<i class="fas fa-calendar-check hbc-icon gray"></i>' +
          '<input type="date" data-bc-field="return_date" name="return_date" class="hbc-input">';
        const dtRow = dateEl.closest('.row') || dateEl.parentNode;
        dtRow.parentNode.insertBefore(retWrap, dtRow.nextSibling);
      }

      // Ensure Live CRM Plan selector exists
      const submitBtn = form.querySelector('button[onclick*="submitHeroBooking"], button.hbc-btn, button[type="submit"]');
      if (!form.querySelector('[data-bc-field="package_public_id"]') && submitBtn) {
        const planGroup = document.createElement('div');
        planGroup.className = 'hbc-input-group';
        planGroup.innerHTML =
          '<label>Select Cab &amp; Live Plan <span style="color:#ef4444;">*</span></label>' +
          '<select data-bc-field="package_public_id" class="hbc-input" style="padding-left:12px;">' +
          '<option value="">Loading live cab plans…</option>' +
          '</select>' +
          '<div class="bc-plan-status" style="font-size:12px;color:#475569;margin-top:6px;"></div>';
        submitBtn.parentNode.insertBefore(planGroup, submitBtn);
      }

      if (submitBtn) {
        submitBtn.removeAttribute('onclick');
        submitBtn.type = 'submit';
        submitBtn.textContent = 'Confirm Booking';
      }
      const hint = form.querySelector('.bc-form-hint');
      if (hint) hint.textContent = 'Instant booking confirmation on WhatsApp with verified driver details.';
      if (pickupEl && !pickupEl.placeholder) pickupEl.placeholder = 'Enter pickup city or landmark';
    });
  };
  enhanceHeroForms();

  // Indian mobile numbers, with optional +91 / 0 prefix. Mirrors bc_normalize_mobile() on the server.
  document.querySelectorAll('[data-bc-booking] [data-bc-field="phone"],[id^="phone_instant"],[id="phone_modal"],[id="phone_hero"]').forEach(input => {
    input.type = 'tel';
    input.inputMode = 'tel';
    input.autocomplete = 'tel';
    input.pattern = '\\s*(\\+?91|0)?[\\s\\-]*[6-9]([\\s\\-]*[0-9]){9}\\s*';
    input.title = 'Enter a 10-digit Indian mobile number';
  });

  // Source markup places labels beside inputs without "for"; link them for screen readers and bigger tap areas.
  document.querySelectorAll('form label:not([for])').forEach((label, index) => {
    if (label.querySelector('input,select,textarea')) return;
    const control = label.parentElement?.querySelector('input,select,textarea');
    if (!control) return;
    if (!control.id) control.id = 'bc-field-' + index;
    label.htmlFor = control.id;
  });

  // Vehicle, city and service cards all share one booking modal, carrying the visitor's choice into it.
  const bookingModal = document.getElementById('bookingModal');
  const openBooking = (choice) => {
    if (!bookingModal || !window.bootstrap) return false;
    const set = (id, value) => { const el = document.getElementById(id); if (el && value) el.value = value; };
    if (choice.drop) {
      set('drop_location_modal', choice.drop);
      document.getElementById('drop_location_modal')?.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const category = document.getElementById('category_modal');
    if (category && 'category' in choice) { category.selectedIndex = 0; set('category_modal', choice.category); }
    const notes = document.getElementById('instructions_modal');
    if (notes && (!notes.value || notes.value.startsWith('Vehicle: '))) notes.value = choice.vehicle ? 'Vehicle: ' + choice.vehicle : '';
    const modalForm = bookingModal.querySelector('form[data-bc-booking]');
    if (choice.planPublicId && modalForm) {
      modalForm.dataset.bcPreferredPlan = choice.planPublicId;
      const planSel = modalForm.querySelector('[data-bc-field="package_public_id"]');
      if (planSel && Array.from(planSel.options).some(o => o.value === choice.planPublicId)) {
        planSel.value = choice.planPublicId;
      } else if (typeof modalForm._bcLoadPlans === 'function') {
        modalForm._bcLoadPlans();
      }
    }
    window.bootstrap.Modal.getOrCreateInstance(bookingModal).show();
    return true;
  };

  // Replace static fleet showcase cards (.fleet-card) with live CRM cab data from /wp-json/biharcabs/v1/plans.
  const hydrateLiveCabsFromCRM = async () => {
    if (!config.plansUrl) return;
    const fleetCards = Array.from(document.querySelectorAll('.fleet-card'));
    if (fleetCards.length === 0) return;

    // Find the lowest common ancestor holding ALL static .fleet-card elements (works in both Bootstrap & Elementor)
    const findCommonAncestor = (nodes) => {
      if (nodes.length === 1) return nodes[0].parentElement;
      const ancestors = [];
      let cur = nodes[0].parentElement;
      while (cur) { ancestors.push(cur); cur = cur.parentElement; }
      for (const anc of ancestors) {
        if (nodes.every(n => anc.contains(n))) return anc;
      }
      return nodes[0].parentElement;
    };
    const grid = findCommonAncestor(fleetCards);
    if (!grid || grid.dataset.bcLiveCabsHydrated) return;
    grid.dataset.bcLiveCabsHydrated = '1';

    // Reuse theme cab images already present on the page (no hardcoded external URLs)
    const imgs = Array.from(grid.querySelectorAll('img')).map(i => i.getAttribute('src')).filter(Boolean);
    const sedanImg = imgs.find(s => /sedan/i.test(s)) || imgs[0] || '';
    const suvImg = imgs.find(s => /suv/i.test(s)) || imgs[1] || sedanImg;
    const pickCabImage = (cat) => (/SUV|LUX/i.test(String(cat || '')) ? suvImg : sedanImg);

    try {
      const resp = await fetch(config.plansUrl);
      const data = await resp.json();
      if (!data?.success || !Array.isArray(data.cabs) || data.cabs.length === 0) return;

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px;width:100%;margin-top:12px;';

      data.cabs.forEach((cab) => {
        const card = document.createElement('div');
        card.className = 'fleet-card h-100 d-flex flex-column';
        card.style.cssText = 'background:#fff;border-radius:16px;padding:24px;border:1px solid #e2e8f0;box-shadow:0 6px 20px rgba(15,23,42,0.06);';
        const imgSrc = (cab.image_url && String(cab.image_url).trim()) ? String(cab.image_url).trim() : pickCabImage(cab.category);
        const isPopular = /SEDAN|SUV/i.test(String(cab.category || '')) && !/PRIME/i.test(String(cab.category || ''));
        if (isPopular) {
          card.style.border = '2px solid #f59e0b';
          card.style.boxShadow = '0 10px 28px rgba(245,158,11,0.16)';
        }

        const badgeHtml = isPopular
          ? '<div class="badge bg-warning text-dark mb-3 px-3 py-2 align-self-start" style="font-size:12px;">Popular Choice</div>'
          : '<div class="badge bg-light text-dark border mb-3 px-3 py-2 align-self-start" style="font-size:12px;">' + String(cab.fuel_type || 'AC') + ' • ' + String(cab.plan_count || 0) + ' Plans</div>';
        const imgHtml = imgSrc
          ? '<img src="' + imgSrc.replace(/"/g, '&quot;') + '" alt="' + String(cab.display_name || 'Cab').replace(/"/g, '&quot;') + '" style="width:100%;height:170px;object-fit:cover;border-radius:12px;margin-bottom:16px;">'
          : '';
        const models = cab.models_description ? String(cab.models_description) : (cab.category + ' AC Cab');
        const fareStr = Number(cab.starting_fare || 0).toLocaleString('en-IN');

        card.innerHTML =
          badgeHtml +
          imgHtml +
          '<h4 style="font-family:\'Outfit\',sans-serif;font-weight:700;color:#0f172a;margin-bottom:4px;"></h4>' +
          '<p class="bc-cab-models" style="color:#475569;font-size:13px;margin-bottom:10px;"></p>' +
          '<div style="font-size:17px;font-weight:800;color:#c2410c;margin-bottom:12px;">From ₹' + fareStr + ' <span style="font-size:11px;font-weight:500;color:#475569;">(incl. GST &amp; fee)</span></div>' +
          '<hr style="margin:8px 0 14px;border-color:#e2e8f0;">' +
          '<div class="d-flex justify-content-between mb-2" style="font-size:13px;color:#334155;font-weight:600;">' +
            '<span><i class="fas fa-user-friends me-1"></i> ' + Number(cab.seating_capacity || 4) + ' Seats</span>' +
            '<span><i class="fas fa-suitcase me-1"></i> ' + Number(cab.luggage_bags || 2) + ' Bags</span>' +
          '</div>' +
          '<div style="font-size:12px;color:#475569;margin-bottom:18px;">Per Day (12h): ₹' + Number(cab.per_day_charge || 0) + ' • Extra: ₹' + Number(cab.extra_hour_charge || 0) + '/hr, ₹' + Number(cab.extra_km_charge || 0) + '/km</div>' +
          '<button type="button" class="' + (isPopular ? 'btn-primary-custom' : 'btn btn-dark w-100 py-3 font-weight-bold') + ' mt-auto bc-live-cab-book" style="border-radius:10px;"></button>';

        card.querySelector('h4').textContent = cab.display_name;
        card.querySelector('.bc-cab-models').textContent = models;
        const btn = card.querySelector('.bc-live-cab-book');
        btn.textContent = 'Book ' + cab.display_name;
        btn.addEventListener('click', () => {
          const catMap = { RENTAL: 'Rental', LOCAL: 'Local', OUTSTATION: 'One Way (Drop)' };
          openBooking({
            vehicle: cab.display_name,
            category: catMap[cab.starting_booking_type] || 'Rental',
            planPublicId: cab.starting_plan_public_id,
          });
        });

        wrapper.appendChild(card);
      });

      grid.style.display = 'block';
      grid.style.width = '100%';
      grid.replaceChildren(wrapper);
    } catch (_) {
      // Keep page functional without fabricating data
    }
  };
  hydrateLiveCabsFromCRM();
  if (!document.documentElement.dataset.bcCtaBound) {
    document.documentElement.dataset.bcCtaBound = '1';
    document.addEventListener('click', event => {
      const cta = event.target.closest('a[href="#"],button:not([type])');
      if (!cta || cta.closest('form,.modal')) return;
      const wanted = cta.textContent.trim().match(/^Book\s+(.+)$/i)?.[1];
      if (!wanted) return;
      let choice;
      const city = wanted.match(/^Ride to (.+)$/i)?.[1];
      if (city) choice = { drop: city };
      else if (/^now$/i.test(wanted)) {
        const service = cta.closest('.e-con')?.querySelector('h3,h4')?.textContent || '';
        choice = { category: /airport/i.test(service) ? 'Airport Transfer' : /local/i.test(service) ? 'Local Rental' : '' };
      } else choice = { vehicle: wanted };
      if (openBooking(choice)) event.preventDefault();
    });
  }

  // Validate source type=button bookings too, including manually entered past dates.
  document.querySelectorAll('button[onclick*="Booking"]').forEach(button => {
   if(button.dataset.bcValidate)return;button.dataset.bcValidate='1';
   button.addEventListener('click',event=>{
    const form=button.closest('form'); if(!form)return;
    const date=form.querySelector('[type=date]');const time=form.querySelector('[type=time]');
    if(!form.reportValidity() || (date?.value && time?.value && new Date(date.value+'T'+time.value)<new Date())){
     event.stopImmediatePropagation();event.preventDefault();alert('Please enter complete details and a future pickup time.');
     return;
    }
    // Capture lead details from button click form
    const pickup = form.querySelector('[name*="pickup"], [id*="pickup"]')?.value?.trim() || '';
    const drop = form.querySelector('[name*="drop"], [id*="drop"]')?.value?.trim() || '';
    const phone = form.querySelector('[name*="phone"], [id*="phone"]')?.value?.trim() || '';
    const name = form.querySelector('[name*="name"], [id*="name"]')?.value?.trim() || '';
    const value = selector => form.querySelector(selector)?.value?.trim() || '';
    const distance = form.querySelector('[id*="estimated_distance"]')?.textContent?.trim() || '';
    saveLeadToDB({ pickup, drop, phone, name, date: date?.value || '', time: time?.value || '', passengers: value('[id*="passengers"]'), category: value('[id*="category"]'), instructions: value('[id*="instructions"]'), distance: distance === '-' ? '' : distance, source: 'Modal / Button Booking' });
    showNextStep(form);
   },true);
   button.closest('form')?.addEventListener('submit',event=>{event.preventDefault();button.click();});
  });

  document.querySelectorAll('a.theme-btn[href="#"]').forEach(a=>{if(a.textContent.includes('Choose Plan')){a.setAttribute('data-bs-toggle','modal');a.setAttribute('data-bs-target','#bookingModal');}});
  document.querySelectorAll('.hbc-tab').forEach(tab=>{
   if(tab.dataset.bcTabBound)return;tab.dataset.bcTabBound='1';tab.setAttribute('role','button');tab.tabIndex=0;
   const select=()=>{tab.closest('.hbc-tabs').querySelectorAll('.hbc-tab').forEach(item=>{item.classList.toggle('active',item===tab);item.setAttribute('aria-pressed',item===tab?'true':'false');});};
   tab.addEventListener('click',select);tab.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});
  });

  const resolveBookingMode = (form) => {
    const activeTab = form.closest('.hero-booking-card')?.querySelector('.hbc-tab.active');
    const catVal = (activeTab ? activeTab.textContent : form.querySelector('[data-bc-field="category"]')?.value || '').trim();
    const lower = catVal.toLowerCase();
    const isRoundTrip = lower.includes('round');
    const bookingType = lower.includes('rental') ? 'RENTAL' : (lower.includes('local') || lower.includes('airport')) ? 'LOCAL' : 'OUTSTATION';
    return { categoryLabel: catVal || 'Outstation', bookingType, isRoundTrip };
  };

  document.querySelectorAll('[data-bc-booking]').forEach(form=>{
   if(form.dataset.bcBookingBound)return;form.dataset.bcBookingBound='1';
   const field=role=>form.querySelector('[data-bc-field="'+role+'"]');
   const dateInput=field('date');
   const returnDateInput=field('return_date');
   const returnDateWrap=form.querySelector('.bc-return-date-wrap');
   const todayStr=(()=>{const now=new Date();return now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');})();
   if(dateInput){dateInput.min=todayStr;if(!dateInput.value)dateInput.value=todayStr;}
   if(returnDateInput){returnDateInput.min=todayStr;}

   const syncReturnDateVisibility = () => {
     const { isRoundTrip } = resolveBookingMode(form);
     if (returnDateWrap) returnDateWrap.style.display = isRoundTrip ? '' : 'none';
     if (returnDateInput) {
       returnDateInput.required = isRoundTrip;
       returnDateInput.min = dateInput?.value || todayStr;
       if (isRoundTrip && (!returnDateInput.value || returnDateInput.value < returnDateInput.min)) {
         returnDateInput.value = returnDateInput.min;
       }
     }
   };
   syncReturnDateVisibility();
   dateInput?.addEventListener('change', syncReturnDateVisibility);
   field('category')?.addEventListener('change', syncReturnDateVisibility);
   form.closest('.hero-booking-card')?.querySelectorAll('.hbc-tab').forEach(tab => {
     tab.addEventListener('click', () => setTimeout(syncReturnDateVisibility, 10));
   });

   form.addEventListener('submit',event=>{
    event.preventDefault();if(!form.reportValidity())return;
    const pickup=field('pickup')?.value.trim(),drop=field('drop')?.value.trim(),date=field('date')?.value,time=field('time')?.value;
    const name=field('name')?.value.trim() || '';
    const phone=field('phone')?.value.trim() || '';
    if(!name || name.length < 2){alert('Please enter your full name so we can confirm your booking.');field('name')?.focus();return;}
    if(!phone){alert('Please enter your 10-digit mobile number for WhatsApp confirmation.');field('phone')?.focus();return;}
    if(!pickup||!drop||!date||!time||new Date(date+'T'+time)<new Date()){alert('Please enter complete details and a future pickup time.');return;}

    const { categoryLabel, isRoundTrip } = resolveBookingMode(form);
    const returnDateVal = returnDateInput?.value || '';
    if (isRoundTrip && returnDateVal && returnDateVal < date) {
      alert('Return date cannot be earlier than pickup date.');
      returnDateInput?.focus();
      return;
    }

    const passengers=field('passengers')?.value.trim() || '1';
    const instructions=field('instructions')?.value.trim() || '';
    const estimate=field('distance')?.textContent;

    // 1. Immediately Save Lead into WordPress Database!
    saveLeadToDB({
      pickup, drop, date, time, name, phone, passengers, category: categoryLabel,
      distance: (estimate && estimate !== '-') ? estimate : '',
      instructions, source: form.dataset.bcSource || 'Website Booking Form'
    });

    // 2. If a CRM plan was selected and direct booking API is configured, book directly via CRM API (triggers WA workflow)
    const selectedPlanId = form.querySelector('[data-bc-field="package_public_id"]')?.value?.trim() || '';
    if (selectedPlanId && config.bookUrl) {
      const submitBtn = form.querySelector('[type=submit]');
      const oldLabel = submitBtn ? submitBtn.textContent : '';
      const fromLat = form.dataset.bcFromLat ? Number(form.dataset.bcFromLat) : undefined;
      const fromLon = form.dataset.bcFromLon ? Number(form.dataset.bcFromLon) : undefined;
      const toLat = form.dataset.bcToLat ? Number(form.dataset.bcToLat) : undefined;
      const toLon = form.dataset.bcToLon ? Number(form.dataset.bcToLon) : undefined;
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Confirming booking…'; }
      fetch(config.bookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package_public_id: selectedPlanId,
          customer_name: name,
          customer_phone: phone,
          origin_city: pickup,
          destination_city: drop,
          pickup_address: pickup,
          drop_address: drop,
          pickup_date: date,
          pickup_time: time,
          is_round_trip: Boolean(isRoundTrip),
          return_date: isRoundTrip ? (returnDateVal || date) : null,
          ...(Number.isFinite(fromLat) && Number.isFinite(fromLon) ? { from_lat: fromLat, from_lon: fromLon } : {}),
          ...(Number.isFinite(toLat) && Number.isFinite(toLon) ? { to_lat: toLat, to_lon: toLon } : {}),
          special_notes: instructions
        })
      })
        .then(r => r.json())
        .then(res => {
          let box = form.querySelector('.bc-next-step');
          if (!box) { box = document.createElement('div'); box.className = 'bc-next-step'; box.setAttribute('role', 'status'); form.appendChild(box); }
          if (res && res.success) {
            box.style.cssText = 'margin-top:12px;padding:12px 14px;border-radius:10px;background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46;font-size:13px;font-weight:600;';
            box.textContent = '✅ Booking #' + res.booking_code + ' confirmed (' + res.plan_name + ' — ₹' + Number(res.total_payment).toLocaleString('en-IN') + ' payable at drop). WhatsApp confirmation & verified driver details are on their way!';
            form.reset();
            syncReturnDateVisibility();
          } else {
            box.style.cssText = 'margin-top:12px;padding:12px 14px;border-radius:10px;background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;font-size:13px;font-weight:600;';
            box.textContent = (res && (res.error || res.message)) || 'Unable to confirm booking right now. Please call us.';
          }
          box.scrollIntoView({ block: 'nearest' });
        })
        .catch(() => {
          alert('Unable to reach booking server. Please try again or call us.');
        })
        .finally(() => {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = oldLabel; }
        });
      return;
    }

    // 3. Fallback: Prepare WhatsApp handoff when no CRM plan is selected (custom quote)
    const number=String(config.whatsapp||'').replace(/\D/g,'');if(!number){alert('Please select a cab plan or call us to book your trip.');return;}
    const lines=['BiharCabs booking enquiry','Name: '+name,'Phone: '+phone,'Trip type: '+categoryLabel,'Pickup: '+pickup,'Drop: '+drop,'Date: '+date,'Time: '+time];
    if(isRoundTrip && returnDateVal) lines.push('Return date: '+returnDateVal);
    if(instructions) lines.push('Instructions: '+instructions);
    if(estimate&&estimate!=='-')lines.push('Estimated distance: '+estimate);
    lines.push('Please confirm availability and fare.');

    window.open('https://wa.me/'+number+'?text='+encodeURIComponent(lines.join('\n')),'_blank','noopener,noreferrer');
    showNextStep(form);
   });

   if(config.plansUrl) {
     const planSelect = form.querySelector('[data-bc-field="package_public_id"]');
     const planStatus = form.querySelector('.bc-plan-status');
     if (planSelect && !planSelect.dataset.bcPlansLoaded) {
       planSelect.dataset.bcPlansLoaded = '1';
       let planSeq = 0;
       const loadPlans = async () => {
         const seq = ++planSeq;
         const prevSelected = planSelect.value;
         const pickupVal = (field('pickup')?.value || '').trim();
         const dropVal = (field('drop')?.value || '').trim();
         const city = pickupVal;
         const destCity = dropVal;
         const pDate = field('date')?.value || '';
         const pTime = field('time')?.value || '';
         const { bookingType, isRoundTrip } = resolveBookingMode(form);
         const returnDateVal = returnDateInput?.value || '';
         const qs = new URLSearchParams();
         qs.set('booking_type', bookingType);
         if (city) qs.set('origin_city', city);
         if (destCity) qs.set('destination_city', destCity);
         if (pDate) qs.set('pickup_date', pDate);
         if (pTime) qs.set('pickup_time', pTime);
         if (isRoundTrip) {
           qs.set('is_round_trip', 'true');
           qs.set('return_date', returnDateVal || pDate);
         }
         if (form.dataset.bcFromLat && form.dataset.bcFromLon) {
           qs.set('from_lat', form.dataset.bcFromLat);
           qs.set('from_lon', form.dataset.bcFromLon);
         }
         if (form.dataset.bcToLat && form.dataset.bcToLon) {
           qs.set('to_lat', form.dataset.bcToLat);
           qs.set('to_lon', form.dataset.bcToLon);
         }

         planSelect.innerHTML = '<option value="">Loading live cab plans…</option>';
         if (planStatus) { planStatus.textContent = ''; planStatus.style.color = '#475569'; }
         const submitBtn = form.querySelector('[type="submit"]');
         if (submitBtn && !submitBtn.dataset.bcDefaultLabel) {
           submitBtn.dataset.bcDefaultLabel = submitBtn.textContent.trim() || 'Confirm Booking';
         }
         const setSubmitMode = (mode) => {
           if (!submitBtn) return;
           submitBtn.textContent =
             mode === 'quote'
               ? 'Get Custom Quote on WhatsApp'
               : (submitBtn.dataset.bcDefaultLabel || 'Confirm Booking');
         };
         try {
           const url = config.plansUrl + '?' + qs.toString();
           const resp = await fetch(url);
           const data = await resp.json();
           if (seq !== planSeq) return;

           if (data?.route_distance?.distance_km > 0) {
             const distEl = field('distance');
             const estBox = field('estimate');
             if (distEl) distEl.textContent = Number(data.route_distance.distance_km).toFixed(1) + ' km';
             if (estBox) {
               estBox.style.display = 'block';
               estBox.querySelectorAll('small').forEach((sm) => {
                 if (/our team will contact/i.test(sm.textContent || '')) sm.style.display = 'none';
               });
             }
           }

           if (data?.service_coverage && data.service_coverage.serviceable === false) {
             planSelect.innerHTML = '<option value="">Service unavailable for this route</option>';
             if (planStatus) {
               planStatus.style.color = '#b91c1c';
               planStatus.textContent = data.service_coverage.reason || 'Sorry, we do not currently provide service for this route.';
             }
             setSubmitMode('quote');
             return;
           }

           let plansList = Array.isArray(data?.plans) ? data.plans : [];
           let fallbackOtherTypes = false;

           // Match WhatsApp Bot behavior: if 0 plans match the selected bookingType (e.g. OUTSTATION),
           // check all other active booking types that fit the route distance & availability.
           if (data?.success && plansList.length === 0) {
             const fallbackQs = new URLSearchParams(qs);
             fallbackQs.delete('booking_type');
             try {
               const fbResp = await fetch(config.plansUrl + (fallbackQs.toString() ? '?' + fallbackQs.toString() : ''));
               const fbData = await fbResp.json();
               if (seq !== planSeq) return;
               if (fbData?.success && Array.isArray(fbData.plans) && fbData.plans.length > 0) {
                 plansList = fbData.plans;
                 fallbackOtherTypes = true;
               }
             } catch (_) {}
           }

           if (!data || !data.success || plansList.length === 0) {
             planSelect.innerHTML = '<option value="">No cabs available for this pickup right now</option>';
             if (planStatus) {
               planStatus.style.color = '#b45309';
               planStatus.textContent = 'Please contact support or submit for a custom WhatsApp quote.';
             }
             setSubmitMode('quote');
             return;
           }

           setSubmitMode('book');

           planSelect.innerHTML = '<option value="">Select an available cab &amp; plan…</option>';
           plansList.forEach((p) => {
             if (p.availability && !p.availability.is_available) return;
             const opt = document.createElement('option');
             opt.value = p.public_id;
             const typeTag = fallbackOtherTypes ? '[' + p.booking_type + '] ' : '';
             opt.textContent = typeTag + p.name + ' — ₹' + Number(p.pricing.total_payment).toLocaleString('en-IN');
             planSelect.appendChild(opt);
           });
           const wantedPlan = form.dataset.bcPreferredPlan || prevSelected;
           if (wantedPlan && Array.from(planSelect.options).some((o) => o.value === wantedPlan)) {
             planSelect.value = wantedPlan;
             delete form.dataset.bcPreferredPlan;
           }
           if (planStatus) {
             planStatus.style.color = fallbackOtherTypes ? '#0369a1' : '#047857';
             planStatus.textContent = fallbackOtherTypes
               ? 'No ' + bookingType + ' plan configured yet — showing ' + plansList.length + ' other available plan' + (plansList.length === 1 ? '' : 's') + ' (incl. GST & platform charge).'
               : plansList.length + ' live ' + bookingType + ' plan' + (plansList.length === 1 ? '' : 's') + ' available (prices include GST & platform charge).';
           }
         } catch (_) {
           if (seq === planSeq) planSelect.innerHTML = '<option value="">Unable to load plans right now</option>';
         }
       };
       form._bcLoadPlans = loadPlans;
       loadPlans();
       [field('pickup'), field('drop'), field('date'), field('time'), field('category'), returnDateInput].forEach((el) => {
         if (el) el.addEventListener('change', loadPlans);
       });
       form.closest('.hero-booking-card')?.querySelectorAll('.hbc-tab').forEach((tab) => {
         tab.addEventListener('click', () => setTimeout(loadPlans, 30));
       });
     }
   }
   if(config.autocompleteUrl || (config.locationEnabled&&config.locationKey))setup('',form);
  });

  if(config.autocompleteUrl || (config.locationEnabled && config.locationKey)) ['', '_instant', '_modal'].forEach(suffix=>setup(suffix));
  else document.querySelectorAll('[id^="auto_detect_btn"]').forEach(button=>{button.setAttribute('aria-disabled','true');button.title='Please enter your pickup location manually';});
 };

 function setup(suffix,form) {
  const find=(id,role)=>form?form.querySelector('[data-bc-field="'+role+'"]'):document.getElementById(id+suffix);
  const pickup=find('pickup_location','pickup'),drop=find('drop_location','drop');
  if(!pickup || !drop || pickup.dataset.bcLocation)return;pickup.dataset.bcLocation='1';
  const box=find('fare_estimate_box','estimate'),distance=find('estimated_distance','distance');
  const auto=find('auto_detect_btn','auto');const coords=new Map();let version=0;
  let fareList=null,quoteSequence=0;
  const clear=()=>{version++;quoteSequence++;fareList?.remove();fareList=null;if(box){box.style.display='none';box.classList.remove('bc-no-distance','bc-has-fares');}if(distance)distance.textContent='-';};
  const notice=document.createElement('small');notice.className='d-block bc-location-notice';notice.setAttribute('role','status');pickup.parentNode.appendChild(notice);
  const request=async(url,signal)=>{const response=await fetch(url,{signal});if(!response.ok)throw new Error('Location service unavailable');return response.json();};
  async function route(){
   clear();const token=version,p=coords.get(pickup),d=coords.get(drop);if(!p||!d)return;
   if(config.plansUrl){
    const ownerForm=pickup.closest('form');
    if(ownerForm && typeof ownerForm._bcLoadPlans==='function') ownerForm._bcLoadPlans();
    return;
   }
   try{const data=await request('https://us1.locationiq.com/v1/directions/driving/'+p.lon+','+p.lat+';'+d.lon+','+d.lat+'?key='+encodeURIComponent(config.locationKey)+'&overview=false');if(token!==version)return;if(data.routes?.[0] && distance && box){distance.textContent=(data.routes[0].distance/1000).toFixed(1)+' km';box.style.display='block';}}
   catch(_){notice.textContent='Distance unavailable. You can still send your booking.';}
   if(token===version)showFares();
  }
  const tripType=()=>{
   const owner=pickup.closest('form');
   const choice=owner?.closest('.hero-booking-card')?.querySelector('.hbc-tab.active')||owner?.querySelector('[data-bc-field="category"],[id*="category"]');
   const label=(choice?.value||choice?.textContent||'').toLowerCase();
   return label.includes('round')?'roundtrip':label.includes('airport')?'airport':label.includes('local')?'local':'oneway';
  };
  // Live CRM plans are the single source of truth; skip legacy WP rate-card /quote when plansUrl is active.
  async function showFares(){
   if(config.plansUrl) return;
   if(!config.quoteUrl||!box)return;
   const sequence=++quoteSequence;
   fareList?.remove();fareList=null;box.classList.remove('bc-has-fares');
   const origin=pickup.value.trim(),destination=drop.value.trim();
   if(!origin||!destination)return;
   const trip=tripType(),from=coords.get(pickup),to=coords.get(drop),now=new Date();
   const today=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
   const body={origin_city:origin,destination_city:destination,trip_type:trip,pickup_date:pickup.closest('form')?.querySelector('[type=date]')?.value||today};
   if(from&&to)Object.assign(body,{origin_lat:from.lat,origin_lon:from.lon,destination_lat:to.lat,destination_lon:to.lon});
   let data;
   try{
    const response=await fetch(config.quoteUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    data=await response.json();
   }catch(_){return;}
   if(sequence!==quoteSequence||!data?.success||!data.quotes?.length)return;
   const list=document.createElement('div');list.className='bc-fare-list';
   data.quotes.forEach(item=>{
    const row=document.createElement('div');row.className='bc-fare-row';
    const name=document.createElement('span'),price=document.createElement('strong');
    name.textContent=item.vehicle_name;price.textContent='₹'+Number(item.total_fare).toLocaleString('en-IN');
    row.append(name,price);list.appendChild(row);
   });
   const note=document.createElement('small');note.className='bc-fare-note';
   note.textContent=['Estimated fare'+(trip==='roundtrip'?' for a same-day return':''),data.quotes[0].toll_tax_text,'We confirm the final fare on WhatsApp'].filter(Boolean).join('. ')+'.';
   list.appendChild(note);box.appendChild(list);fareList=list;
   const km=Number(data.route?.distance_km);
   if(km>0&&distance)distance.textContent=km.toFixed(1)+' km';
   box.classList.toggle('bc-no-distance',!(km>0));box.classList.add('bc-has-fares');
   box.style.display='block';
  }
  [pickup,drop].forEach(input=>input.addEventListener('change',showFares));
  pickup.closest('form')?.querySelector('select[data-bc-field="category"],select[id*="category"]')?.addEventListener('change',showFares);
  pickup.closest('.hero-booking-card')?.querySelectorAll('.hbc-tab').forEach(tab=>['click','keydown'].forEach(name=>tab.addEventListener(name,()=>setTimeout(showFares))));
  [pickup,drop].forEach(input=>{
   let timer,controller,sequence=0;const list=document.createElement('div');list.className='autocomplete-suggestions';input.parentNode.style.position='relative';input.parentNode.appendChild(list);input.autocomplete='off';
   input.addEventListener('input',()=>{
    clearTimeout(timer);controller?.abort();coords.delete(input);clear();list.replaceChildren();list.style.display='none';notice.textContent='';const current=++sequence;const q=input.value.trim();if(q.length<3)return;
    timer=setTimeout(async()=>{
     controller=new AbortController();
     try{
      let items=[];
      if(config.autocompleteUrl){
       const res=await request(config.autocompleteUrl+(config.autocompleteUrl.includes('?')?'&':'?')+'q='+encodeURIComponent(q),controller.signal);
       if(current!==sequence)return;
       items=Array.isArray(res?.suggestions)?res.suggestions:[];
      }else{
       const data=await request('https://api.locationiq.com/v1/autocomplete?key='+encodeURIComponent(config.locationKey)+'&q='+encodeURIComponent(q)+'&countrycodes=in&limit=5',controller.signal);
       if(current!==sequence)return;
       items=Array.isArray(data)?data:[];
      }
      list.replaceChildren();items.forEach(item=>{
       const option=document.createElement('button');option.type='button';option.className='autocomplete-suggestion';option.style.cssText='display:block;width:100%;text-align:left;border:0;background:white;padding:8px 10px;border-bottom:1px solid #f1f5f9;';
       const title=document.createElement('strong'),desc=document.createElement('small');
       title.textContent=item.short_name||item.address?.name||item.display_place||item.display_name;
       desc.textContent=item.display_address||item.display_name||'';
       desc.className='d-block text-muted';option.append(title,desc);
       option.addEventListener('click',()=>{
        input.value=item.display_name;
        coords.set(input,{lat:Number(item.lat),lon:Number(item.lon)});
        const ownerForm=input.closest('form');
        if(ownerForm){
         if(input===pickup){ownerForm.dataset.bcFromLat=String(item.lat);ownerForm.dataset.bcFromLon=String(item.lon);}
         if(input===drop){ownerForm.dataset.bcToLat=String(item.lat);ownerForm.dataset.bcToLon=String(item.lon);}
         if(typeof ownerForm._bcLoadPlans==='function') ownerForm._bcLoadPlans();
        }
        list.style.display='none';
        route();
       });list.appendChild(option);
      });list.style.display=items.length?'block':'none';
     }catch(error){if(error.name!=='AbortError')notice.textContent='Suggestions unavailable. Please type your location manually.';}
    },350);
   });
   input.addEventListener('keydown',e=>{if(e.key==='Escape')list.style.display='none';if(e.key==='ArrowDown'){e.preventDefault();list.querySelector('button')?.focus();}});
   document.addEventListener('click',e=>{if(!input.parentNode.contains(e.target))list.style.display='none';});
  });
  if(auto){auto.setAttribute('role','button');auto.tabIndex=0;auto.setAttribute('aria-label','Use my current location');auto.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();auto.click();}});
   auto.addEventListener('click',()=>{
    if(!navigator.geolocation){notice.textContent='Location unavailable. Please enter your pickup.';return;}
    notice.textContent='Finding your location…';const token=version;
    navigator.geolocation.getCurrentPosition(async position=>{
     try{const {latitude:lat,longitude:lon}=position.coords;const data=await request('https://us1.locationiq.com/v1/reverse?key='+encodeURIComponent(config.locationKey)+'&lat='+lat+'&lon='+lon+'&format=json');if(token!==version)return;if(!data.display_name)throw new Error('No address');pickup.value=data.display_name;coords.set(pickup,{lat,lon});notice.textContent='';route();}
     catch(_){notice.textContent='Could not detect the address. Please enter it manually.';}
    },()=>{notice.textContent='Location permission unavailable. Please enter your pickup manually.';},{timeout:10000,maximumAge:60000});
   });
  }
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
 // The desktop floating buttons repeat the hero booking form, so keep them out of its way while it is on screen.
 const watchHeroForm=()=>{
  const card=document.querySelector('.hero-booking-card');
  if(!card||!('IntersectionObserver' in window)||document.documentElement.dataset.bcHeroWatch)return;
  document.documentElement.dataset.bcHeroWatch='1';
  new IntersectionObserver(([entry])=>document.body.classList.toggle('bc-hero-form-visible',entry.isIntersecting),{threshold:0.2}).observe(card);
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watchHeroForm);else watchHeroForm();
 const editorReady=()=>{['biharcabs-demo','biharcabs-form'].forEach(name=>window.elementorFrontend?.hooks.addAction('frontend/element_ready/'+name+'.default',ready));};
 window.addEventListener('elementor/frontend/init',editorReady);if(window.jQuery)window.jQuery(window).on('elementor/frontend/init',editorReady);
})();
