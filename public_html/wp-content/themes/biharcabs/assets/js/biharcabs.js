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
    window.bootstrap.Modal.getOrCreateInstance(bookingModal).show();
    return true;
  };
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
  document.querySelectorAll('.bc-native-page .hbc-tab').forEach(tab=>{
   if(tab.dataset.bcTabBound)return;tab.dataset.bcTabBound='1';tab.setAttribute('role','button');tab.tabIndex=0;
   const select=()=>{tab.closest('.hbc-tabs').querySelectorAll('.hbc-tab').forEach(item=>{item.classList.toggle('active',item===tab);item.setAttribute('aria-pressed',item===tab?'true':'false');});};
   tab.addEventListener('click',select);tab.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});
  });

  document.querySelectorAll('[data-bc-booking]').forEach(form=>{
   if(form.dataset.bcBookingBound)return;form.dataset.bcBookingBound='1';
   const field=role=>form.querySelector('[data-bc-field="'+role+'"]');
   const dateInput=field('date');if(dateInput){const now=new Date();dateInput.min=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');}

   form.addEventListener('submit',event=>{
    event.preventDefault();if(!form.reportValidity())return;
    const pickup=field('pickup')?.value.trim(),drop=field('drop')?.value.trim(),date=field('date')?.value,time=field('time')?.value;
    if(!pickup||!drop||!date||!time||new Date(date+'T'+time)<new Date()){alert('Please enter complete details and a future pickup time.');return;}
    const number=String(config.whatsapp||'').replace(/\D/g,'');if(!number){alert('Please call us to book your trip.');return;}

    const name=field('name')?.value.trim() || '';
    const phone=field('phone')?.value.trim() || '';
    const passengers=field('passengers')?.value.trim() || '1';
    const instructions=field('instructions')?.value.trim() || '';
    const selected=form.closest('.hero-booking-card')?.querySelector('.hbc-tab.active');
    const category=selected ? selected.textContent.trim() : (field('category')?.value.trim() || 'One Way');
    const estimate=field('distance')?.textContent;

    // 1. Immediately Save Lead into WordPress Database!
    saveLeadToDB({
      pickup, drop, date, time, name, phone, passengers, category,
      distance: (estimate && estimate !== '-') ? estimate : '',
      instructions, source: 'Hero / Section Booking Form'
    });

    // 2. Prepare WhatsApp payload
    const lines=['BiharCabs booking enquiry','Pickup: '+pickup,'Drop: '+drop,'Date: '+date,'Time: '+time];
    [['name','Name'],['phone','Phone'],['passengers','Passengers'],['category','Trip type'],['instructions','Instructions']].forEach(([role,label])=>{const value=field(role)?.value.trim();if(value)lines.push(label+': '+value);});
    if(selected) lines.push('Trip type: '+selected.textContent.trim());
    if(estimate&&estimate!=='-')lines.push('Estimated distance: '+estimate);
    lines.push('Please confirm availability and fare.');

    // 3. Open WhatsApp
    window.open('https://wa.me/'+number+'?text='+encodeURIComponent(lines.join('\n')),'_blank','noopener,noreferrer');
    showNextStep(form);
   });
   if(config.locationEnabled&&config.locationKey)setup('',form);
  });

  if(config.locationEnabled && config.locationKey) ['', '_instant', '_modal'].forEach(suffix=>setup(suffix));
  else document.querySelectorAll('[id^="auto_detect_btn"]').forEach(button=>{button.setAttribute('aria-disabled','true');button.title='Please enter your pickup location manually';});
 };

 function setup(suffix,form) {
  const find=(id,role)=>form?form.querySelector('[data-bc-field="'+role+'"]'):document.getElementById(id+suffix);
  const pickup=find('pickup_location','pickup'),drop=find('drop_location','drop');
  if(!pickup || !drop || pickup.dataset.bcLocation)return;pickup.dataset.bcLocation='1';
  const box=find('fare_estimate_box','estimate'),distance=find('estimated_distance','distance');
  const auto=find('auto_detect_btn','auto');const coords=new Map();let version=0;
  const clear=()=>{version++;if(box)box.style.display='none';if(distance)distance.textContent='-';};
  const notice=document.createElement('small');notice.className='d-block bc-location-notice';notice.setAttribute('role','status');pickup.parentNode.appendChild(notice);
  const request=async(url,signal)=>{const response=await fetch(url,{signal});if(!response.ok)throw new Error('Location service unavailable');return response.json();};
  async function route(){
   clear();const token=version,p=coords.get(pickup),d=coords.get(drop);if(!p||!d)return;
   try{const data=await request('https://us1.locationiq.com/v1/directions/driving/'+p.lon+','+p.lat+';'+d.lon+','+d.lat+'?key='+encodeURIComponent(config.locationKey)+'&overview=false');if(token!==version)return;if(data.routes?.[0] && distance && box){distance.textContent=(data.routes[0].distance/1000).toFixed(1)+' km';box.style.display='block';}}
   catch(_){notice.textContent='Distance unavailable. You can still send your booking.';}
  }
  [pickup,drop].forEach(input=>{
   let timer,controller,sequence=0;const list=document.createElement('div');list.className='autocomplete-suggestions';input.parentNode.style.position='relative';input.parentNode.appendChild(list);input.autocomplete='off';
   input.addEventListener('input',()=>{
    clearTimeout(timer);controller?.abort();coords.delete(input);clear();list.replaceChildren();list.style.display='none';notice.textContent='';const current=++sequence;const q=input.value.trim();if(q.length<3)return;
    timer=setTimeout(async()=>{
     controller=new AbortController();
     try{const data=await request('https://api.locationiq.com/v1/autocomplete?key='+encodeURIComponent(config.locationKey)+'&q='+encodeURIComponent(q)+'&countrycodes=in&limit=5',controller.signal);if(current!==sequence)return;
      if(!Array.isArray(data))throw new Error('No results');
      list.replaceChildren();data.forEach(item=>{
       const option=document.createElement('button');option.type='button';option.className='autocomplete-suggestion';option.style.cssText='display:block;width:100%;text-align:left;border:0;background:white';
       const title=document.createElement('strong'),desc=document.createElement('small');title.textContent=item.address?.name||item.display_place||item.display_name;desc.textContent=item.display_address||'';desc.className='d-block text-muted';option.append(title,desc);
       option.addEventListener('click',()=>{input.value=item.display_name;coords.set(input,{lat:Number(item.lat),lon:Number(item.lon)});list.style.display='none';route();});list.appendChild(option);
      });list.style.display=data.length?'block':'none';
     }catch(error){if(error.name!=='AbortError')notice.textContent='Suggestions unavailable. Please type your location manually.';}
    },500);
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
