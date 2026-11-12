'use strict';
const { openBrowser } = require('./browser-helper');
const base = process.env.ROLLBOARD_BASE || 'http://127.0.0.1:5173';
(async () => {
  const browser = await openBrowser(base);
  try {
    await browser.viewport(1600, 900);
    await browser.navigate('/board.html');
    await browser.until('window.__steps && window.__steps.length > 0');
    await browser.evaluate("document.getElementById('pureBtn').click(); document.getElementById('splash').click();");
    const results = [];
    for (const [width, height, cpu] of [[1600, 900, 1], [3840, 2160, 1], [1600, 900, 4]]) {
      await browser.viewport(width, height);
      await browser.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      for (const mode of ['problem', 'submission']) {
        for (const speed of (cpu === 1 && width === 1600 ? [120, 60] : [60])) {
          await browser.evaluate(`document.getElementById('modeSel').value='${mode}'; document.getElementById('modeSel').dispatchEvent(new Event('change')); document.getElementById('speedSel').value='${speed}'; document.getElementById('soundChk').checked=true; window.__goto(100);`);
          await browser.sleep(300);
          const sample = await browser.evaluate(`(async()=>{
            const frames=[], paints=[], tasks=[]; let run=true,last=window.__cursor;
            const frame=t=>{frames.push(t);if(run)requestAnimationFrame(frame);};requestAnimationFrame(frame);
            const observer=new MutationObserver(()=>{const at=window.__cursor;if(at!==last){paints.push({t:performance.now(),delta:at-last});last=at;}});
            observer.observe(document.getElementById('tbody'),{subtree:true,attributes:true,childList:true,characterData:true});
            const long=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(t=>t.duration)));long.observe({entryTypes:['longtask']});
            document.getElementById('playBtn').click(); await new Promise(r=>setTimeout(r,6000)); document.getElementById('playBtn').click();
            run=false;observer.disconnect();long.disconnect();
            const gaps=frames.slice(1).map((t,i)=>t-frames[i]).sort((a,b)=>a-b);
            const q=p=>+(gaps[Math.min(gaps.length-1,Math.floor(gaps.length*p))]||0).toFixed(2);
            return {frames:frames.length,medianMs:q(.5),p95Ms:q(.95),p99Ms:q(.99),worstMs:q(1),
              over50ms:gaps.filter(t=>t>50).length,dropRatio:+(gaps.filter(t=>t>30).length/Math.max(1,gaps.length)).toFixed(4),
              updates:paints.length,skippedUpdates:paints.filter(p=>p.delta>1).length,longTasks:tasks.length,worstTaskMs:+Math.max(0,...tasks).toFixed(2),
              rowsCorrect:JSON.stringify([...document.querySelectorAll('#tbody tr')].map(t=>t.dataset.team))===JSON.stringify(window.__steps[window.__cursor].frame.ranks.map(r=>r.teamId))};
          })()`);
          results.push({ width, height, cpu, mode, speed, ...sample });
        }
      }
    }
    console.log(JSON.stringify({ data: await browser.evaluate('({teams:window.__data.teams.length,problems:window.__data.problems.length})'), results, errors: browser.errors }, null, 2));
    if (results.some(r => !r.rowsCorrect || r.skippedUpdates) || browser.errors.length) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
