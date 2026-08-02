import { chromium } from 'playwright';
const S='/tmp/claude-1000/-home-jio-projects-prombot/72b0d6ed-f270-4439-8bce-3c9997b1d5b0/scratchpad';
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1280,height:900}});
await p.goto('https://prombot-one.vercel.app', {waitUntil:'networkidle'});
const ta = p.locator('#prompt_beg0');
await ta.evaluate(e=>e.focus());
await p.keyboard.press('Control+A'); await p.keyboard.press('Backspace');
await p.keyboard.type('1girl, solo, long hair, blue ey', {delay:35});
await p.waitForTimeout(900);
console.log(await p.evaluate(()=>{
  const fake=document.querySelector('.fakeTextarea');
  const wrap=fake.parentElement;
  const out=[];
  out.push('WRAPPER html:\n'+wrap.outerHTML.slice(0,2500));
  return out.join('\n');
}));
await p.screenshot({path:S+'/ref-desktop.png', fullPage:false});
await b.close();
