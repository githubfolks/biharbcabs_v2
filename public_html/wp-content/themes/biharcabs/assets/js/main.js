/* Biharcabs UI: native APIs; no legacy popup, carousel, select or jQuery UI libraries. */
(function () {
 'use strict';
 const all=(selector)=>document.querySelectorAll(selector);
 const on=(selector,callback)=>all(selector).forEach(el=>el.addEventListener('click',callback));
 const toggle=(selector,name)=>all(selector).forEach(el=>el.classList.toggle(name));
 on('.search-btn',()=>toggle('.search-area','open'));
 on('.sidebar-btn',()=>{all('.sidebar-popup,.sidebar-wrapper').forEach(el=>el.classList.add('open'));});
 on('.close-sidebar-popup,.sidebar-popup',()=>{all('.sidebar-popup,.sidebar-wrapper').forEach(el=>el.classList.remove('open'));});
 function scrollState(){
  const y=window.scrollY || document.documentElement.scrollTop;
  all('#scroll-top').forEach(el=>el.classList.toggle('active',y>100));
  all('.navbar').forEach(el=>el.classList.toggle('fixed-top',Boolean(window.biharcabs?.sticky)&&y>50));
 }
 window.addEventListener('scroll',scrollState,{passive:true});scrollState();
 on('#scroll-top',event=>{event.preventDefault();window.scrollTo({top:0,behavior:'smooth'});});
 const hideLoader=()=>all('.preloader').forEach(el=>{el.style.display='none';});
 if(document.readyState==='complete')hideLoader();else window.addEventListener('load',hideLoader,{once:true});
 window.setTimeout(hideLoader,8000);
 all('#date').forEach(el=>{el.textContent=String(new Date().getFullYear());});
 // Only the Fares demo uses the source's reveal-animation classes.
 const reveal=el=>{el.classList.add('animated');el.style.visibility='visible';};
 if('IntersectionObserver' in window){
  const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){reveal(entry.target);observer.unobserve(entry.target);}}));
  all('.wow').forEach(el=>{el.style.visibility='hidden';el.style.animationDuration='1s';if(/^\d*\.?\d+s$/.test(el.dataset.wowDelay||''))el.style.animationDelay=el.dataset.wowDelay;observer.observe(el);});
 }else all('.wow').forEach(reveal);
})();
