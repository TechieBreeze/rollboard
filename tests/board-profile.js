'use strict';
const { openBrowser } = require('./browser-helper');
(async () => {
  const browser = await openBrowser(process.env.ROLLBOARD_BASE || 'http://127.0.0.1:5173');
  try {
    await browser.viewport(1600, 900); await browser.navigate('/board.html');
    await browser.until('window.__steps && window.__steps.length > 0');
    await browser.evaluate("document.getElementById('pureBtn').click();document.getElementById('splash').click();document.getElementById('speedSel').value='60';window.__goto(100);");
    await browser.sleep(400); await browser.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await browser.send('Performance.enable'); await browser.send('Profiler.enable'); await browser.send('Profiler.start');
    const before = (await browser.send('Performance.getMetrics')).metrics;
    await browser.evaluate("document.getElementById('playBtn').click()"); await browser.sleep(8000);
    await browser.evaluate("document.getElementById('playBtn').click()");
    const after = (await browser.send('Performance.getMetrics')).metrics;
    const { profile } = await browser.send('Profiler.stop');
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    profile.samples.forEach((id, i) => {
      const node = nodes.get(id); const name = node.callFrame.functionName + ' ' + node.callFrame.url.split('/').slice(-1)[0] + ':' + (node.callFrame.lineNumber + 1);
      self.set(name, (self.get(name) || 0) + profile.timeDeltas[i]);
    });
    console.log(JSON.stringify({ topSelfMs: [...self].map(([name, us]) => ({ name, ms: +(us / 1000).toFixed(1) })).sort((a,b) => b.ms-a.ms).slice(0,20),
      metrics: after.filter((m) => /Layout|Recalc|Script|Task/.test(m.name)).map((m) => ({ name: m.name, delta: m.value - (before.find(b=>b.name===m.name)?.value || 0) })) }, null, 2));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
