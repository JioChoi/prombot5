import { chromium } from 'playwright';
const S='/tmp/claude-1000/-home-jio-projects-prombot/72b0d6ed-f270-4439-8bce-3c9997b1d5b0/scratchpad';
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1280,height:900}});
await p.goto('https://prombot-one.vercel.app', {waitUntil:'networkidle'});
const ta = p.locator('#prompt_beg0');
await ta.evaluate(e=>e.focus());
await p.keyboard.press('Control+A'); await p.keyboard.press('Backspace');
await p.keyboard.type('1girl, solo, long hair, blue ey', {delay:35});
await p.waitForTimeout(1000);
console.log(await p.evaluate(()=>{
  const fake=document.querySelector('.fakeTextarea');
  const spans=[...fake.querySelectorAll('span')];
  const last=spans[spans.length-2];
  const sug=[...document.querySelectorAll('body *')].find(e=>/blue eyes/i.test(e.textContent||'') && e.children.length>1 && !e.querySelector('textarea') && !e.classList.contains('fakeTextarea') && e.getBoundingClientRect().height<500);
  const r=e=>e?JSON.stringify(e.getBoundingClientRect().toJSON()):null;
  return JSON.stringify({
    lastSpan:{rect:r(last), offsetTop:last.offsetTop, offsetLeft:last.offsetLeft, text:last.textContent},
    fakeScroll:{scrollTop:fake.scrollTop, taScrollTop:document.querySelector('#prompt_beg0').scrollTop},
    sug: sug && {cls:String(sug.className).slice(0,160), style:sug.getAttribute('style'), pos:getComputedStyle(sug).position, rect:r(sug), parent:String(sug.parentElement.className).slice(0,120), parentPos:getComputedStyle(sug.parentElement).position, parentRect:r(sug.parentElement), html:sug.outerHTML.slice(0,600)},
  },null,1);
}));
await p.screenshot({path:S+'/ref-sug.png'});
await b.close();
